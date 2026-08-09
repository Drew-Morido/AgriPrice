"""
AgriPricePH — read access for the rice catalog (DTI categories/brands, price brackets, taxes,
consumer-price computation). Backs the /api/catalog, /api/taxes, /api/prices/brackets and
/api/consumer-price endpoints.

Empty-safe: brands/brackets/taxes are populated only from official DTI/BOC data, so every
function degrades gracefully (returns empty lists / null base + a note) until that data exists.
Schema is created by datasets/catalog_schema.py.
"""

from __future__ import annotations

import os
import sqlite3

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)

# canonical model key -> WS_rice_price column (2026 data) for a live base price fallback.
CANON_TO_WS = {
    "locWellMilled": "Local Well Milled", "locPremium": "Local Premium",
    "locSpecial": "Local Special", "locRegular": "Local Regular Milled",
    "impWellMilled": "Imported Well Milled", "impPremium": "Imported Premium",
    "impSpecial": "Imported Special", "impRegular": "Imported Regular Milled",
}


def _db_path() -> str:
    env = os.environ.get("AGRIPRICE_DB_PATH")
    if env and os.path.isfile(env):
        return env
    datasets_db = os.path.join(PROJECT_ROOT, "datasets", "agriprice_database.db")
    api_db = os.path.join(BASE_DIR, "agriprice_database.db")
    return datasets_db if os.path.isfile(datasets_db) else api_db


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_db_path())
    conn.row_factory = sqlite3.Row
    return conn


def _has_table(conn, name) -> bool:
    cur = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,))
    return cur.fetchone() is not None


def catalog_ready() -> bool:
    """True once the catalog schema has been created (datasets/catalog_schema.py)."""
    conn = _connect()
    try:
        return _has_table(conn, "dti_category")
    finally:
        conn.close()


def list_catalog() -> dict:
    """Categories with their brands (empty brand lists until DTI-verified)."""
    conn = _connect()
    try:
        if not _has_table(conn, "dti_category"):
            return {"ready": False, "categories": [], "note": "Catalog schema not initialized."}
        cats = [dict(r) for r in conn.execute(
            "SELECT id,name,segment,canonical_key,active,dti_verified,notes "
            "FROM dti_category ORDER BY segment,name")]
        brands_by_cat: dict[int, list] = {}
        if _has_table(conn, "rice_brand"):
            for r in conn.execute("SELECT id,category_id,brand_name,is_verified,source FROM rice_brand ORDER BY brand_name"):
                brands_by_cat.setdefault(r["category_id"], []).append(dict(r))
        for c in cats:
            c["brands"] = brands_by_cat.get(c["id"], [])
            c["brands_verified_count"] = sum(1 for b in c["brands"] if b["is_verified"])
        return {"ready": True, "categories": cats,
                "note": "Brand lists require DTI verification." if not any(c["brands"] for c in cats) else ""}
    finally:
        conn.close()


def list_taxes() -> dict:
    conn = _connect()
    try:
        if not _has_table(conn, "tax_component"):
            return {"ready": False, "taxes": [], "note": "Catalog schema not initialized."}
        taxes = [dict(r) for r in conn.execute(
            "SELECT id,name,kind,rate_pct,flat_amount,applies_to,effective_date,legal_basis,source,active,verified "
            "FROM tax_component WHERE active=1 ORDER BY kind")]
        return {"ready": True, "taxes": taxes,
                "note": "No tax components loaded — pending BOC/BIR/DTI verification." if not taxes else ""}
    finally:
        conn.close()


def list_brackets(category_key: str | None = None, market: str | None = None,
                  date: str | None = None, limit: int = 200) -> dict:
    conn = _connect()
    try:
        if not _has_table(conn, "rice_price_bracket"):
            return {"ready": False, "brackets": [], "note": "Catalog schema not initialized."}
        q = ("SELECT b.id,c.canonical_key,c.name AS category,b.effective_date,"
             "b.price_min,b.price_max,b.source, m.province, m.market_name "
             "FROM rice_price_bracket b JOIN dti_category c ON c.id=b.category_id "
             "LEFT JOIN market m ON m.id=b.market_id WHERE 1=1")
        args: list = []
        if category_key:
            q += " AND c.canonical_key=?"; args.append(category_key)
        if date:
            q += " AND b.effective_date=?"; args.append(date)
        if market:
            q += " AND m.province=?"; args.append(market)
        q += " ORDER BY b.effective_date DESC LIMIT ?"; args.append(limit)
        rows = [dict(r) for r in conn.execute(q, args)]
        return {"ready": True, "brackets": rows,
                "note": "No price brackets loaded — pending DTI bracket data." if not rows else ""}
    finally:
        conn.close()


def _latest_base_price(conn, canonical_key: str) -> tuple[float | None, str]:
    """Base price: latest bracket midpoint if available, else latest WS_rice_price value."""
    if _has_table(conn, "rice_price_bracket"):
        row = conn.execute(
            "SELECT b.price_min,b.price_max FROM rice_price_bracket b "
            "JOIN dti_category c ON c.id=b.category_id WHERE c.canonical_key=? "
            "ORDER BY b.effective_date DESC LIMIT 1", (canonical_key,)).fetchone()
        if row and row["price_min"] is not None:
            return (float(row["price_min"]) + float(row["price_max"])) / 2.0, "bracket midpoint"
    col = CANON_TO_WS.get(canonical_key)
    if col and _has_table(conn, "WS_rice_price"):
        try:
            row = conn.execute(
                f'SELECT "{col}" AS v FROM "WS_rice_price" WHERE "{col}" IS NOT NULL '
                'ORDER BY Date DESC LIMIT 1').fetchone()
            if row and row["v"] is not None:
                return float(row["v"]), "latest scraped price"
        except sqlite3.OperationalError:
            pass
    return None, "no price data"


def consumer_price(category_key: str, date: str | None = None) -> dict:
    """Final consumer price = base + Σ applicable taxes. Imported categories get taxes with
    applies_to in ('imported','all'); local categories only 'all'. Empty-safe."""
    conn = _connect()
    try:
        if not _has_table(conn, "dti_category"):
            return {"ready": False, "note": "Catalog schema not initialized."}
        cat = conn.execute(
            "SELECT canonical_key,name,segment FROM dti_category WHERE canonical_key=?",
            (category_key,)).fetchone()
        if not cat:
            return {"ready": True, "error": f"Unknown category '{category_key}'."}
        base, base_src = _latest_base_price(conn, category_key)
        segment = cat["segment"]
        taxes_applied: list = []
        if _has_table(conn, "tax_component") and base is not None:
            scope = ("imported", "all") if segment == "Imported" else ("all",)
            placeholders = ",".join("?" for _ in scope)
            for r in conn.execute(
                    f"SELECT name,kind,rate_pct,flat_amount,legal_basis FROM tax_component "
                    f"WHERE active=1 AND applies_to IN ({placeholders})", scope):
                amt = (base * float(r["rate_pct"]) / 100.0) if r["rate_pct"] is not None \
                    else (float(r["flat_amount"]) if r["flat_amount"] is not None else 0.0)
                taxes_applied.append({
                    "name": r["name"], "kind": r["kind"],
                    "rate_pct": r["rate_pct"], "flat_amount": r["flat_amount"],
                    "amount_added": round(amt, 2), "legal_basis": r["legal_basis"],
                })
        tax_total = round(sum(t["amount_added"] for t in taxes_applied), 2)
        final = round(base + tax_total, 2) if base is not None else None
        note = ""
        if base is None:
            note = "No base price available for this category."
        elif not taxes_applied:
            note = "No tax/import charges loaded — final = base price (tax data pending [VERIFY])."
        return {
            "ready": True, "category": cat["name"], "canonical_key": category_key,
            "segment": segment, "base_price": round(base, 2) if base is not None else None,
            "base_source": base_src, "taxes": taxes_applied, "tax_total": tax_total,
            "final_consumer_price": final, "note": note,
        }
    finally:
        conn.close()

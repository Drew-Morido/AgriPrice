"""
AgriPricePH — read access for the rice catalog (DTI categories/brands, price brackets, taxes,
consumer-price computation). Backs the /api/catalog, /api/taxes, /api/prices/brackets and
/api/consumer-price endpoints.

Empty-safe: brands/brackets/taxes are populated only from official DTI/BOC data, so every
function degrades gracefully (returns empty lists / null base + a note) until that data exists.
Schema is created by datasets/catalog_schema.py.
"""

from __future__ import annotations

import datetime as _dt
import os
import sqlite3

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)

# Rice import tariff is a quarterly, price-indexed MFN rate bounded by law (EO 105 s.2025 +
# IAGRTA Circular No. 2025-001). These constants are legal, not tunable.
TARIFF_BAND_MIN = 15.0   # % floor
TARIFF_BAND_MAX = 35.0   # % ceiling
TARIFF_STEP_PRICE_PCT = 5.0   # every 5% move in the FAO reference price ...
TARIFF_STEP_POINTS = 5.0      # ... shifts the duty by 5 percentage points

# Rice Brand module Phase 2 — variance weight ("patong") sanity band. Originally ±20% on the
# (untested) assumption that a brand's retail premium/discount vs. its category's plain price
# would be modest. Checking real survey data against live category prices disproved that: 14 of
# 36 canvassed brands are named/boutique products (e.g. Doña Maria +116%, imported Harvester's
# +138%) that genuinely retail far above the DA's tracked commodity-category price — that's a
# real market signal, not bad data. NFA (government low-price rice) sits at -52%, so the band
# needs real headroom on both sides. Widened to catch actual fat-finger entries (a brand priced
# at 10x or -95% of its category) without rejecting legitimate premium/discount brands.
BRAND_WEIGHT_BAND_MIN = -70.0
BRAND_WEIGHT_BAND_MAX = 200.0

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


def list_catalog(include_inactive: bool = False) -> dict:
    """Categories with their brands (empty brand lists until DTI-verified). Deactivated brands
    (Phase 3 soft-delete) are excluded by default — pass include_inactive=True for admin views
    that need to see/manage/reactivate them."""
    conn = _connect()
    try:
        if not _has_table(conn, "dti_category"):
            return {"ready": False, "categories": [], "note": "Catalog schema not initialized."}
        cats = [dict(r) for r in conn.execute(
            "SELECT id,name,segment,canonical_key,active,dti_verified,notes "
            "FROM dti_category ORDER BY segment,name")]
        brands_by_cat: dict[int, list] = {}
        if _has_table(conn, "rice_brand"):
            q = ("SELECT id,category_id,brand_name,package,location,source,source_url,"
                 "last_verified,classification_note,verification_status,verified_by,verified_at,"
                 "active,notes FROM rice_brand")
            if not include_inactive:
                q += " WHERE active=1"
            q += " ORDER BY brand_name,package"
            for r in conn.execute(q):
                brands_by_cat.setdefault(r["category_id"], []).append(dict(r))
        for c in cats:
            c["brands"] = brands_by_cat.get(c["id"], [])
            c["brands_verified_count"] = sum(
                1 for b in c["brands"] if b["verification_status"] != "unverified")
        return {"ready": True, "categories": cats,
                "note": "Brand lists require DTI verification." if not any(c["brands"] for c in cats) else ""}
    finally:
        conn.close()


def list_taxes() -> dict:
    conn = _connect()
    try:
        if not _has_table(conn, "tax_component"):
            return {"ready": False, "taxes": [], "note": "Catalog schema not initialized."}
        # Fixed charges (VAT etc.); the tariff is quarterly/date-aware and added below.
        taxes = [dict(r) for r in conn.execute(
            "SELECT id,name,kind,rate_pct,flat_amount,applies_to,effective_date,legal_basis,source,active,verified "
            "FROM tax_component WHERE active=1 AND kind!='tariff' ORDER BY kind")]
        tariff = _applicable_tariff(conn)
        note = ""
        if tariff:
            taxes.insert(0, {
                "id": None, "name": f"Rice Import Tariff (MFN, {tariff.get('quarter_label') or 'current'})",
                "kind": "tariff", "rate_pct": tariff["rate_pct"], "flat_amount": None,
                "applies_to": "imported", "effective_date": tariff.get("effective_start"),
                "effective_end": tariff.get("effective_end"),
                "legal_basis": tariff.get("legal_basis"), "source": tariff.get("source"),
                "source_url": tariff.get("da_certification_url"),
                "active": 1, "verified": tariff.get("verified", 0),
                "stale": bool(tariff.get("stale")),
            })
            if tariff.get("stale"):
                note = "⚠ " + tariff["stale_reason"]
        if not taxes:
            note = "No tax components loaded — pending BOC/BIR/DTI verification."
        return {"ready": True, "taxes": taxes, "tariff": tariff, "note": note}
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


# ── Quarterly tariff (dated, source-verified, staleness-aware) ──────────────────

def _today() -> str:
    return _dt.date.today().isoformat()


def _quarter_label(date_str: str) -> str:
    """'YYYY-MM-DD' -> 'Qn YYYY'."""
    try:
        d = _dt.date.fromisoformat(date_str[:10])
    except (ValueError, TypeError):
        return ""
    return f"Q{(d.month - 1) // 3 + 1} {d.year}"


_ENTRY_TYPE_ENSURED = False


def _ensure_entry_type(conn) -> None:
    """Self-healing migration: add tariff_schedule.entry_type if an older DB lacks it, so the
    Admin-Entry feature works without requiring the seed script to have run. Runs once per process."""
    global _ENTRY_TYPE_ENSURED
    if _ENTRY_TYPE_ENSURED or not _has_table(conn, "tariff_schedule"):
        return
    try:
        cols = [r[1] for r in conn.execute("PRAGMA table_info(tariff_schedule)")]
        if "entry_type" not in cols:
            conn.execute("ALTER TABLE tariff_schedule ADD COLUMN entry_type TEXT NOT NULL DEFAULT 'OFFICIAL'")
            conn.commit()
        _ENTRY_TYPE_ENSURED = True
    except sqlite3.OperationalError:
        pass


def _applicable_tariff(conn, date_str: str | None = None) -> dict | None:
    """The tariff row applicable ON date_str. If a dated row covers the date -> not stale.
    If the date falls outside every row (e.g. a new quarter with no confirmed rate yet), return
    the LAST CONFIRMED row flagged stale — never invent a rate, never silently roll forward."""
    if not _has_table(conn, "tariff_schedule"):
        return None
    _ensure_entry_type(conn)
    date_str = (date_str or _today())[:10]
    rows = [dict(r) for r in conn.execute(
        "SELECT id,rate_pct,effective_start,effective_end,quarter_label,legal_basis,"
        "da_certification_url,source,verified,approved_by,approved_at,entry_type "
        "FROM tariff_schedule WHERE active=1 ORDER BY effective_start DESC")]
    if not rows:
        return None
    cur_q = _quarter_label(date_str)
    for r in rows:  # newest first
        start = (r["effective_start"] or "")[:10]
        end = (r["effective_end"] or "")[:10]
        covers = start <= date_str and (not end or date_str <= end)
        if covers:
            r["stale"] = False
            r["stale_reason"] = ""
            r["as_of_quarter"] = cur_q
            return r
    last = rows[0]  # most recent confirmed
    last["stale"] = True
    last["as_of_quarter"] = cur_q
    last["stale_reason"] = (
        f"No confirmed tariff for {cur_q}. Showing the last confirmed rate "
        f"({last.get('quarter_label') or last['effective_start']}). The DA issues a certification "
        "within the first month of each quarter (posted on da.gov.ph) and BOC issues a CMO — "
        "add that rate here once published.")
    return last


def _tariff_config(conn) -> dict:
    out = {}
    if _has_table(conn, "tariff_config"):
        for r in conn.execute("SELECT key,value,source,updated_at FROM tariff_config"):
            out[r["key"]] = {"value": r["value"], "source": r["source"], "updated_at": r["updated_at"]}
    return out


def tariff_status(date: str | None = None) -> dict:
    """Current applicable tariff + full dated schedule + FAO helper config. Empty-safe."""
    conn = _connect()
    try:
        if not _has_table(conn, "tariff_schedule"):
            return {"ready": False, "applicable": None, "schedule": [],
                    "note": "Tariff schedule not initialized — run datasets/seed_verified_data.py."}
        applicable = _applicable_tariff(conn, date)
        schedule = [dict(r) for r in conn.execute(
            "SELECT id,rate_pct,effective_start,effective_end,quarter_label,legal_basis,"
            "da_certification_url,source,verified,approved_by,approved_at,active,entry_type "
            "FROM tariff_schedule ORDER BY effective_start DESC")]
        note = ""
        if applicable and applicable.get("stale"):
            note = applicable["stale_reason"]
        elif not applicable:
            note = "No tariff rows loaded."
        return {"ready": True, "as_of": (date or _today())[:10],
                "band": {"min": TARIFF_BAND_MIN, "max": TARIFF_BAND_MAX},
                "applicable": applicable, "schedule": schedule,
                "config": _tariff_config(conn), "note": note}
    finally:
        conn.close()


def add_tariff_quarter(rate_pct: float, effective_start: str, effective_end: str | None = None,
                       quarter_label: str | None = None, legal_basis: str | None = None,
                       da_certification_url: str | None = None, source: str | None = None,
                       actor: str = "admin", verified: int = 1) -> dict:
    """Append a confirmed quarterly tariff row + audit entry. Validates the legal 15-35% band and
    that the date is not already present. Does not overwrite past quarters."""
    try:
        rate = float(rate_pct)
    except (TypeError, ValueError):
        return {"ok": False, "error": "rate_pct must be a number."}
    if not (TARIFF_BAND_MIN <= rate <= TARIFF_BAND_MAX):
        return {"ok": False,
                "error": f"rate_pct {rate} outside the legal {TARIFF_BAND_MIN:.0f}-{TARIFF_BAND_MAX:.0f}% band."}
    try:
        _dt.date.fromisoformat((effective_start or "")[:10])
    except (ValueError, TypeError):
        return {"ok": False, "error": "effective_start must be YYYY-MM-DD."}
    if effective_end:
        try:
            _dt.date.fromisoformat(effective_end[:10])
        except ValueError:
            return {"ok": False, "error": "effective_end must be YYYY-MM-DD."}
    conn = _connect()
    try:
        if not _has_table(conn, "tariff_schedule"):
            return {"ok": False, "error": "Tariff schedule not initialized."}
        _ensure_entry_type(conn)
        if conn.execute("SELECT 1 FROM tariff_schedule WHERE effective_start=? AND active=1",
                        (effective_start[:10],)).fetchone():
            return {"ok": False, "error": f"A tariff already starts on {effective_start[:10]}."}
        qlabel = quarter_label or _quarter_label(effective_start)
        cur = conn.execute(
            "INSERT INTO tariff_schedule(rate_pct,effective_start,effective_end,quarter_label,"
            "legal_basis,da_certification_url,source,verified,approved_by,approved_at,active,"
            "entry_type,notes) "
            "VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),1,'ADMIN',?)",
            (rate, effective_start[:10], (effective_end or None), qlabel, legal_basis,
             da_certification_url, source, int(bool(verified)), actor,
             "Added via admin tariff form."))
        conn.execute(
            "INSERT INTO tariff_audit(action,rate_pct,effective_start,effective_end,quarter_label,"
            "actor,detail) VALUES ('add',?,?,?,?,?,?)",
            (rate, effective_start[:10], (effective_end or None), qlabel, actor,
             legal_basis or da_certification_url or "manual add"))
        conn.commit()
        return {"ok": True, "id": cur.lastrowid, "quarter_label": qlabel, "rate_pct": rate}
    finally:
        conn.close()


def set_tariff_active(tariff_id: int, active: bool, actor: str = "admin") -> dict:
    """Activate/deactivate a tariff row (keeps the record for history/audit). An inactive row is
    never selected by _applicable_tariff()/consumer_price(), so it cannot affect calculations."""
    try:
        tid = int(tariff_id)
    except (TypeError, ValueError):
        return {"ok": False, "error": "tariff id must be an integer."}
    active_int = 1 if active else 0
    conn = _connect()
    try:
        if not _has_table(conn, "tariff_schedule"):
            return {"ok": False, "error": "Tariff schedule not initialized."}
        row = conn.execute(
            "SELECT id,rate_pct,effective_start,effective_end,quarter_label,active "
            "FROM tariff_schedule WHERE id=?", (tid,)).fetchone()
        if not row:
            return {"ok": False, "error": f"Tariff #{tid} not found."}
        if int(row["active"]) == active_int:
            return {"ok": True, "id": tid, "active": bool(active_int),
                    "quarter_label": row["quarter_label"], "unchanged": True}
        conn.execute("UPDATE tariff_schedule SET active=? WHERE id=?", (active_int, tid))
        conn.execute(
            "INSERT INTO tariff_audit(action,rate_pct,effective_start,effective_end,quarter_label,"
            "actor,detail) VALUES (?,?,?,?,?,?,?)",
            ("activate" if active_int else "deactivate", row["rate_pct"], row["effective_start"],
             row["effective_end"], row["quarter_label"], actor,
             f"status {int(row['active'])}->{active_int}"))
        conn.commit()
        return {"ok": True, "id": tid, "active": bool(active_int),
                "quarter_label": row["quarter_label"], "rate_pct": row["rate_pct"]}
    finally:
        conn.close()


def list_tariff_audit(limit: int = 50) -> dict:
    conn = _connect()
    try:
        if not _has_table(conn, "tariff_audit"):
            return {"ready": False, "audit": []}
        rows = [dict(r) for r in conn.execute(
            "SELECT action,rate_pct,effective_start,effective_end,quarter_label,actor,detail,created_at "
            "FROM tariff_audit ORDER BY id DESC LIMIT ?", (int(limit),))]
        return {"ready": True, "audit": rows}
    finally:
        conn.close()


def fao_indicative(current_price: float, baseline_price: float | None = None) -> dict:
    """Indicative-only helper. Given the current FAO Vietnam-5%-broken price and the March-2025
    baseline, compute the number of 5% price steps and the resulting duty magnitude within the
    15-35% band, per IAGRTA Circular 2025-001's '±5pp per 5% move' rule. This is a DECISION AID,
    not the legal rate — the DA certification / BOC CMO is authoritative and its direction/exact
    banding must be confirmed there before entering a rate."""
    conn = _connect()
    try:
        cfg = _tariff_config(conn)
    finally:
        conn.close()
    if baseline_price is None:
        raw = cfg.get("fao_baseline_price", {}).get("value")
        baseline_price = float(raw) if raw not in (None, "") else None
    if not baseline_price:
        return {"ok": False, "baseline_set": False,
                "error": "March-2025 FAO baseline not set. An admin must set fao_baseline_price "
                         "(verify from FAO) before the helper can suggest a rate.",
                "band": {"min": TARIFF_BAND_MIN, "max": TARIFF_BAND_MAX}}
    try:
        cur = float(current_price)
    except (TypeError, ValueError):
        return {"ok": False, "error": "current_price must be a number."}
    pct_change = (cur - baseline_price) / baseline_price * 100.0
    steps = int(abs(pct_change) // TARIFF_STEP_PRICE_PCT)
    magnitude_pp = steps * TARIFF_STEP_POINTS
    return {
        "ok": True, "baseline_set": True,
        "baseline_price": baseline_price, "current_price": cur,
        "pct_change": round(pct_change, 2), "steps_of_5pct": steps,
        "adjustment_points": magnitude_pp,
        "band": {"min": TARIFF_BAND_MIN, "max": TARIFF_BAND_MAX},
        "note": "Indicative magnitude only. Direction and the exact rate are set by the DA "
                "certification / BOC CMO — confirm there, then enter the official rate. "
                f"Legal band {TARIFF_BAND_MIN:.0f}-{TARIFF_BAND_MAX:.0f}%.",
    }


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
        tariff_info: dict | None = None
        # Fixed charges from tax_component (VAT etc.) — the tariff is handled separately by date.
        if _has_table(conn, "tax_component") and base is not None:
            scope = ("imported", "all") if segment == "Imported" else ("all",)
            placeholders = ",".join("?" for _ in scope)
            for r in conn.execute(
                    f"SELECT name,kind,rate_pct,flat_amount,legal_basis FROM tax_component "
                    f"WHERE active=1 AND kind!='tariff' AND applies_to IN ({placeholders})", scope):
                amt = (base * float(r["rate_pct"]) / 100.0) if r["rate_pct"] is not None \
                    else (float(r["flat_amount"]) if r["flat_amount"] is not None else 0.0)
                taxes_applied.append({
                    "name": r["name"], "kind": r["kind"],
                    "rate_pct": r["rate_pct"], "flat_amount": r["flat_amount"],
                    "amount_added": round(amt, 2), "legal_basis": r["legal_basis"],
                })
        # Quarterly, date-aware import tariff (imported rice only).
        if segment == "Imported" and base is not None:
            tariff_info = _applicable_tariff(conn, date)
            if tariff_info:
                amt = base * float(tariff_info["rate_pct"]) / 100.0
                taxes_applied.append({
                    "name": f"Rice Import Tariff (MFN, {tariff_info.get('quarter_label') or 'current'})",
                    "kind": "tariff", "rate_pct": tariff_info["rate_pct"], "flat_amount": None,
                    "amount_added": round(amt, 2), "legal_basis": tariff_info.get("legal_basis"),
                    "stale": bool(tariff_info.get("stale")),
                    "effective_start": tariff_info.get("effective_start"),
                    "effective_end": tariff_info.get("effective_end"),
                    "source_url": tariff_info.get("da_certification_url"),
                })
        tax_total = round(sum(t["amount_added"] for t in taxes_applied), 2)
        final = round(base + tax_total, 2) if base is not None else None
        note = ""
        if base is None:
            note = "No base price available for this category."
        elif tariff_info and tariff_info.get("stale"):
            note = "⚠ " + tariff_info["stale_reason"]
        elif not taxes_applied:
            note = "No tax/import charges loaded — final = base price (tax data pending [VERIFY])."
        return {
            "ready": True, "category": cat["name"], "canonical_key": category_key,
            "segment": segment, "base_price": round(base, 2) if base is not None else None,
            "base_source": base_src, "taxes": taxes_applied, "tax_total": tax_total,
            "final_consumer_price": final, "tariff": tariff_info, "note": note,
        }
    finally:
        conn.close()


# ── Rice Brand module Phase 2 — variance weight ("patong") ──────────────────────
# Display-layer only: a brand's price here is base_price × (1 + weight_pct/100). Never fed back
# into the LSTM/model — model/ never sees this. A brand with no canvassed weight yet simply shows
# the plain category price (estimated=False) — that's an honest state, not something to fake.

def brand_price(category_key: str, include_inactive: bool = False) -> dict:
    """Every brand mapped to `category_key`, each with its own adjusted price (or the plain
    category price as a fallback when no weight has been canvassed for that brand yet). A
    deactivated (Phase 3 soft-delete) brand is excluded by default."""
    conn = _connect()
    try:
        if not _has_table(conn, "dti_category"):
            return {"ready": False, "brands": [], "note": "Catalog schema not initialized."}
        cat = conn.execute(
            "SELECT id,canonical_key,name,segment FROM dti_category WHERE canonical_key=?",
            (category_key,)).fetchone()
        if not cat:
            return {"ready": True, "error": f"Unknown category '{category_key}'.", "brands": []}

        base, base_src = _latest_base_price(conn, category_key)

        weights_by_brand: dict[int, dict] = {}
        if _has_table(conn, "brand_price_adjustment"):
            for r in conn.execute(
                    "SELECT brand_id,weight_pct,sample_date,sample_locations,sample_n,"
                    "source_notes,entry_type,updated_by,updated_at FROM brand_price_adjustment"):
                weights_by_brand[r["brand_id"]] = dict(r)

        brands_out = []
        if _has_table(conn, "rice_brand"):
            q = ("SELECT id,brand_name,package,location,source,source_url,last_verified,"
                 "classification_note,verification_status,verified_by,verified_at,active,notes "
                 "FROM rice_brand WHERE category_id=?")
            if not include_inactive:
                q += " AND active=1"
            q += " ORDER BY brand_name,package"
            for b in conn.execute(q, (cat["id"],)):
                b = dict(b)
                w = weights_by_brand.get(b["id"])
                if w and base is not None:
                    price = round(base * (1.0 + float(w["weight_pct"]) / 100.0), 2)
                    estimated = True
                else:
                    price = round(base, 2) if base is not None else None
                    estimated = False
                brands_out.append({
                    **b,
                    "price": price,
                    "estimated": estimated,
                    "weight_pct": w["weight_pct"] if w else None,
                    "sample_date": w["sample_date"] if w else None,
                    "sample_locations": w["sample_locations"] if w else None,
                    "sample_n": w["sample_n"] if w else None,
                    "source_notes": w["source_notes"] if w else None,
                    "updated_by": w["updated_by"] if w else None,
                    "updated_at": w["updated_at"] if w else None,
                })

        return {
            "ready": True, "category": cat["name"], "canonical_key": cat["canonical_key"],
            "segment": cat["segment"], "base_price": round(base, 2) if base is not None else None,
            "base_source": base_src, "brands": brands_out,
            "note": "" if base is not None else "No base price available for this category.",
        }
    finally:
        conn.close()


def set_brand_weight(brand_id: int, weight_pct, sample_date: str | None = None,
                     sample_locations: str | None = None, sample_n: int | None = None,
                     source_notes: str | None = None, actor: str = "admin") -> dict:
    """Set (or, with weight_pct=None, clear) one brand's canvassed variance weight. Validates the
    sanity band (BRAND_WEIGHT_BAND_MIN/MAX), upserts brand_price_adjustment, and appends a
    brand_weight_audit row — never invents a weight; the caller must supply one from actual
    field canvassing."""
    try:
        bid = int(brand_id)
    except (TypeError, ValueError):
        return {"ok": False, "error": "brand_id must be an integer."}

    conn = _connect()
    try:
        if not _has_table(conn, "brand_price_adjustment"):
            return {"ok": False, "error": "Brand weight schema not initialized."}
        brand = conn.execute(
            "SELECT b.id,b.brand_name,c.canonical_key FROM rice_brand b "
            "JOIN dti_category c ON c.id=b.category_id WHERE b.id=?", (bid,)).fetchone()
        if not brand:
            return {"ok": False, "error": f"Brand #{bid} not found."}

        # weight_pct is None (or '') -> clear any existing weight, brand reverts to the plain
        # category price. This is the "I have no field data for this brand" honest state.
        if weight_pct in (None, ""):
            existing = conn.execute(
                "SELECT 1 FROM brand_price_adjustment WHERE brand_id=?", (bid,)).fetchone()
            conn.execute("DELETE FROM brand_price_adjustment WHERE brand_id=?", (bid,))
            conn.execute(
                "INSERT INTO brand_weight_audit(brand_id,action,actor,detail) VALUES (?,?,?,?)",
                (bid, "clear", actor, f"Cleared weight for {brand['brand_name']}."
                 if existing else "No-op clear (no weight was set)."))
            conn.commit()
            return {"ok": True, "brand_id": bid, "weight_pct": None, "cleared": True}

        try:
            weight = float(weight_pct)
        except (TypeError, ValueError):
            return {"ok": False, "error": "weight_pct must be a number."}
        if not (BRAND_WEIGHT_BAND_MIN <= weight <= BRAND_WEIGHT_BAND_MAX):
            return {"ok": False, "error": f"weight_pct {weight} outside the "
                    f"{BRAND_WEIGHT_BAND_MIN:.0f}% to {BRAND_WEIGHT_BAND_MAX:+.0f}% sanity band."}
        if sample_date:
            try:
                _dt.date.fromisoformat(sample_date[:10])
            except ValueError:
                return {"ok": False, "error": "sample_date must be YYYY-MM-DD."}
        n = None
        if sample_n not in (None, ""):
            try:
                n = int(sample_n)
            except (TypeError, ValueError):
                return {"ok": False, "error": "sample_n must be an integer."}

        conn.execute(
            "INSERT INTO brand_price_adjustment(brand_id,weight_pct,sample_date,sample_locations,"
            "sample_n,source_notes,entry_type,updated_by,updated_at) "
            "VALUES (?,?,?,?,?,?,'ADMIN',?,datetime('now')) "
            "ON CONFLICT(brand_id) DO UPDATE SET weight_pct=excluded.weight_pct,"
            "sample_date=excluded.sample_date, sample_locations=excluded.sample_locations,"
            "sample_n=excluded.sample_n, source_notes=excluded.source_notes,"
            "updated_by=excluded.updated_by, updated_at=excluded.updated_at",
            (bid, weight, (sample_date or None)[:10] if sample_date else None,
             sample_locations or None, n, source_notes or None, actor))
        conn.execute(
            "INSERT INTO brand_weight_audit(brand_id,action,weight_pct,sample_date,"
            "sample_locations,sample_n,actor,detail) VALUES (?,'set',?,?,?,?,?,?)",
            (bid, weight, sample_date[:10] if sample_date else None, sample_locations, n, actor,
             f"Set weight for {brand['brand_name']} to {weight:+.2f}%."))
        conn.commit()
        return {"ok": True, "brand_id": bid, "brand_name": brand["brand_name"], "weight_pct": weight}
    finally:
        conn.close()


def list_brand_weight_audit(brand_id: int | None = None, limit: int = 100) -> dict:
    conn = _connect()
    try:
        if not _has_table(conn, "brand_weight_audit"):
            return {"ready": False, "audit": []}
        if brand_id is not None:
            rows = [dict(r) for r in conn.execute(
                "SELECT id,brand_id,action,weight_pct,sample_date,sample_locations,sample_n,"
                "actor,detail,created_at FROM brand_weight_audit WHERE brand_id=? "
                "ORDER BY id DESC LIMIT ?", (int(brand_id), int(limit)))]
        else:
            rows = [dict(r) for r in conn.execute(
                "SELECT id,brand_id,action,weight_pct,sample_date,sample_locations,sample_n,"
                "actor,detail,created_at FROM brand_weight_audit ORDER BY id DESC LIMIT ?",
                (int(limit),))]
        return {"ready": True, "audit": rows}
    finally:
        conn.close()


# ── Rice Brand module Phase 3 — full CRUD + governance ───────────────────────────
# add_brand / update_brand / deactivate_brand are the only ways the brand catalog record itself
# changes; every one of them writes a brand_audit row. Nothing here is ever fed into model/ —
# this is still purely the display-layer catalog on top of the 8 forecast categories.

VERIFICATION_STATUSES = ("unverified", "field_verified", "dti_verified")


def _brand_dict(row) -> dict:
    return dict(row) if row is not None else None


def _resolve_category(conn, category_key: str):
    return conn.execute(
        "SELECT id,name,canonical_key FROM dti_category WHERE canonical_key=?",
        (category_key,)).fetchone()


def _duplicate_brand(conn, category_id: int, brand_name: str, package: str | None,
                     exclude_id: int | None = None):
    q = ("SELECT id,active FROM rice_brand WHERE category_id=? AND brand_name=? AND "
         "(package IS ? OR package = ?)")
    args = [category_id, brand_name, package, package]
    if exclude_id is not None:
        q += " AND id != ?"
        args.append(exclude_id)
    return conn.execute(q, args).fetchone()


def add_brand(category_key: str, brand_name: str, package: str | None = None,
             location: str | None = None, source: str | None = None,
             source_url: str | None = None, last_verified: str | None = None,
             classification_note: str | None = None, notes: str | None = None,
             verification_status: str = "unverified", actor: str = "admin") -> dict:
    """Add a new brand row. Requires brand_name, category_key (must resolve to one of the 8
    categories) and source (a citation for where this entry came from) — never invented.
    Blocks an exact (category, brand_name, package) duplicate."""
    brand_name = (brand_name or "").strip()
    source = (source or "").strip()
    if not brand_name:
        return {"ok": False, "error": "Brand name is required."}
    if not source:
        return {"ok": False, "error": "A source is required — where did this entry come from?"}
    if verification_status not in VERIFICATION_STATUSES:
        return {"ok": False, "error": f"verification_status must be one of {VERIFICATION_STATUSES}."}

    conn = _connect()
    try:
        if not _has_table(conn, "rice_brand"):
            return {"ok": False, "error": "Catalog schema not initialized."}
        cat = _resolve_category(conn, category_key)
        if not cat:
            return {"ok": False, "error": f"Unknown category '{category_key}'."}

        package = (package or None)
        dup = _duplicate_brand(conn, cat["id"], brand_name, package)
        if dup:
            status = "an existing" if dup["active"] else "a deactivated"
            return {"ok": False, "error": f"{status} brand already has this exact "
                    f"(category, name, package) — reactivate/edit it instead of adding a duplicate.",
                    "duplicate_brand_id": dup["id"]}

        cur = conn.execute(
            "INSERT INTO rice_brand(category_id,brand_name,package,location,source,source_url,"
            "last_verified,classification_note,verification_status,verified_by,verified_at,"
            "active,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)",
            (cat["id"], brand_name, package, location or None, source, source_url or None,
             last_verified or None, classification_note or None, verification_status,
             actor if verification_status != "unverified" else None,
             _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S") if verification_status != "unverified" else None,
             notes or None))
        bid = cur.lastrowid
        conn.execute(
            "INSERT INTO brand_audit(brand_id,action,actor,detail) VALUES (?,'add',?,?)",
            (bid, actor, f"Added '{brand_name}'{f' ({package})' if package else ''} to "
             f"{cat['name']}. Source: {source}."))
        conn.commit()
        return {"ok": True, "brand_id": bid, "brand_name": brand_name}
    finally:
        conn.close()


def update_brand(brand_id: int, category_key: str | None = None, brand_name: str | None = None,
                 package: str | None = None, location: str | None = None,
                 source: str | None = None, source_url: str | None = None,
                 last_verified: str | None = None, classification_note: str | None = None,
                 notes: str | None = None, verification_status: str | None = None,
                 actor: str = "admin") -> dict:
    """Edit an existing brand's fields and/or its verification status. Every field is optional —
    only the ones passed are changed — but the row that results must still satisfy the same
    required-fields and no-duplicate rules as add_brand()."""
    try:
        bid = int(brand_id)
    except (TypeError, ValueError):
        return {"ok": False, "error": "brand_id must be an integer."}

    conn = _connect()
    try:
        if not _has_table(conn, "rice_brand"):
            return {"ok": False, "error": "Catalog schema not initialized."}
        existing = conn.execute(
            "SELECT b.*, c.canonical_key AS current_category_key, c.name AS current_category_name "
            "FROM rice_brand b JOIN dti_category c ON c.id=b.category_id WHERE b.id=?",
            (bid,)).fetchone()
        if not existing:
            return {"ok": False, "error": f"Brand #{bid} not found."}
        existing = dict(existing)

        cat = existing["category_id"]
        cat_name = existing["current_category_name"]
        if category_key and category_key != existing["current_category_key"]:
            new_cat = _resolve_category(conn, category_key)
            if not new_cat:
                return {"ok": False, "error": f"Unknown category '{category_key}'."}
            cat, cat_name = new_cat["id"], new_cat["name"]

        new_name = (brand_name if brand_name is not None else existing["brand_name"]).strip()
        new_package = package if package is not None else existing["package"]
        new_source = (source if source is not None else existing["source"] or "").strip()
        if not new_name:
            return {"ok": False, "error": "Brand name is required."}
        if not new_source:
            return {"ok": False, "error": "A source is required — where did this entry come from?"}

        dup = _duplicate_brand(conn, cat, new_name, new_package, exclude_id=bid)
        if dup:
            status = "an existing" if dup["active"] else "a deactivated"
            return {"ok": False, "error": f"{status} brand already has this exact "
                    f"(category, name, package) — pick a different name/package.",
                    "duplicate_brand_id": dup["id"]}

        new_status = existing["verification_status"]
        new_verified_by = existing["verified_by"]
        new_verified_at = existing["verified_at"]
        if verification_status and verification_status != existing["verification_status"]:
            if verification_status not in VERIFICATION_STATUSES:
                return {"ok": False, "error": f"verification_status must be one of {VERIFICATION_STATUSES}."}
            new_status = verification_status
            new_verified_by = actor if verification_status != "unverified" else None
            new_verified_at = (_dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                               if verification_status != "unverified" else None)

        conn.execute(
            "UPDATE rice_brand SET category_id=?, brand_name=?, package=?, location=?, source=?, "
            "source_url=?, last_verified=?, classification_note=?, notes=?, verification_status=?, "
            "verified_by=?, verified_at=? WHERE id=?",
            (cat, new_name, new_package,
             location if location is not None else existing["location"],
             new_source,
             source_url if source_url is not None else existing["source_url"],
             last_verified if last_verified is not None else existing["last_verified"],
             classification_note if classification_note is not None else existing["classification_note"],
             notes if notes is not None else existing["notes"],
             new_status, new_verified_by, new_verified_at, bid))

        changes = []
        if new_name != existing["brand_name"]:
            changes.append(f"name '{existing['brand_name']}'->'{new_name}'")
        if cat != existing["category_id"]:
            changes.append(f"category '{existing['current_category_name']}'->'{cat_name}'")
        if new_status != existing["verification_status"]:
            changes.append(f"verification '{existing['verification_status']}'->'{new_status}'")
        if new_source != (existing["source"] or ""):
            changes.append("source updated")
        detail = ("Updated " + ", ".join(changes)) if changes else "Updated (no field changes detected)"
        conn.execute(
            "INSERT INTO brand_audit(brand_id,action,actor,detail) VALUES (?,'update',?,?)",
            (bid, actor, detail))
        conn.commit()
        return {"ok": True, "brand_id": bid, "brand_name": new_name}
    finally:
        conn.close()


def deactivate_brand(brand_id: int, active: bool = False, actor: str = "admin") -> dict:
    """Soft-delete (active=False, the default) or restore (active=True) a brand. History —
    weights, audit rows — is kept either way; a deactivated brand just stops showing up in the
    public catalog and in brand-prices."""
    try:
        bid = int(brand_id)
    except (TypeError, ValueError):
        return {"ok": False, "error": "brand_id must be an integer."}
    active_int = 1 if active else 0

    conn = _connect()
    try:
        if not _has_table(conn, "rice_brand"):
            return {"ok": False, "error": "Catalog schema not initialized."}
        row = conn.execute(
            "SELECT id,brand_name,active FROM rice_brand WHERE id=?", (bid,)).fetchone()
        if not row:
            return {"ok": False, "error": f"Brand #{bid} not found."}
        if int(row["active"]) == active_int:
            return {"ok": True, "brand_id": bid, "active": bool(active_int), "unchanged": True}

        conn.execute("UPDATE rice_brand SET active=? WHERE id=?", (active_int, bid))
        action = "reactivate" if active_int else "deactivate"
        conn.execute(
            "INSERT INTO brand_audit(brand_id,action,actor,detail) VALUES (?,?,?,?)",
            (bid, action, actor, f"{action.capitalize()}d '{row['brand_name']}'."))
        conn.commit()
        return {"ok": True, "brand_id": bid, "brand_name": row["brand_name"], "active": bool(active_int)}
    finally:
        conn.close()


def list_brand_audit(brand_id: int | None = None, limit: int = 100) -> dict:
    conn = _connect()
    try:
        if not _has_table(conn, "brand_audit"):
            return {"ready": False, "audit": []}
        if brand_id is not None:
            rows = [dict(r) for r in conn.execute(
                "SELECT id,brand_id,action,actor,detail,created_at FROM brand_audit "
                "WHERE brand_id=? ORDER BY id DESC LIMIT ?", (int(brand_id), int(limit)))]
        else:
            rows = [dict(r) for r in conn.execute(
                "SELECT id,brand_id,action,actor,detail,created_at FROM brand_audit "
                "ORDER BY id DESC LIMIT ?", (int(limit),))]
        return {"ready": True, "audit": rows}
    finally:
        conn.close()

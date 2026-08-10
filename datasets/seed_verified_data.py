"""
AgriPricePH — seed VERIFIED external data into the rice-catalog schema.

Every row here is backed by a cited public source (recorded in the `source` / `legal_basis`
columns). Nothing is invented. Run after datasets/catalog_schema.py:

    py -3.13 datasets/seed_verified_data.py

Sources
-------
- Rice import tariff: EO 62 s.2024 cut the MFN rice tariff 35%->15%; EO 105 s.2025 +
  DA Circular 2025-001 made it a price-indexed 15-35% quarterly rate (15% for Jan-Mar 2026).
  RA 11203 (Rice Tariffication Act) set the original 35% (ASEAN) / 50% (non-ASEAN).
  Refs: USDA FAS RP2026-0004; USDA FAS "EO 62 Modifying Import Duty Rates"; RA 11203.
- VAT: rice is VAT-EXEMPT as an agricultural food product in its original state (NIRC Sec 109).
- Price brackets: DA "Bantay Presyo" prevailing retail price ranges (reported via PNA, 2026);
  refresh from the official DA Bantay Presyo daily monitoring sheets.
- Brands: DA / DA-AMAS monitor rice by CATEGORY and price range, NOT by brand — so no brand
  rows are seeded here. Brand membership must be sourced from DTI (feedback item #1) [VERIFY].
"""

from __future__ import annotations

import os
import sqlite3

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _db_path() -> str:
    env = os.environ.get("AGRIPRICE_DB_PATH")
    if env and os.path.isfile(env):
        return env
    ds = os.path.join(PROJECT_ROOT, "datasets", "agriprice_database.db")
    return ds if os.path.isfile(ds) else os.path.join(PROJECT_ROOT, "api", "agriprice_database.db")


# kind, name, rate_pct, flat_amount, applies_to, effective_date, legal_basis, source
TAXES = [
    ("tariff", "Rice Import Tariff (MFN)", 15.0, None, "imported", "2026-01-01",
     "EO 105 s.2025 & DA Circular 2025-001 — price-indexed 15-35% (15% for Jan-Mar 2026); "
     "reduced from 35% under RA 11203 by EO 62 s.2024",
     "USDA FAS RP2026-0004; USDA FAS 'Philippines Issued EO 62'"),
    ("VAT", "Value-Added Tax (rice = exempt)", 0.0, None, "all", None,
     "NIRC Sec 109 — polished/husked rice is an agricultural food product in its original state, "
     "hence VAT-EXEMPT (0%). Do not add 12% VAT to rice.",
     "NIRC Sec 109; USDA FAS"),
]

# canonical_key, effective_date, min, max, source  — DA Bantay Presyo ranges (via PNA, 2026)
BRACKETS = [
    ("impWellMilled", "2026-08-01", 46.0, 62.0, "DA Bantay Presyo (PNA, 2026)"),
    ("impRegular",    "2026-08-01", 45.0, 48.0, "DA Bantay Presyo (PNA, 2026)"),
    ("locPremium",    "2026-08-01", 48.0, 62.0, "DA Bantay Presyo (PNA, 2026)"),
]

# NCR-available branded rice products verified from official/retailer sources. Only rows we can
# cite are listed; every other category legitimately shows the empty state. Prices are NOT stored
# here — the catalog pulls them from the forecast per category.
# canonical_key, brand, package, location, source_label, source_url, last_verified, class_note
BRANDS = [
    ("locPremium", "Doña Maria",
     "Doña Maria Jasponica Rice (5kg)", "NCR",
     "Official Brand Website (SL Agritech)", "https://donamaria-rice.com/", "2026-08-10",
     "Locally grown hybrid rice, marketed as premium quality by SL Agritech; DA/DTI grade confirmation pending"),
    ("locPremium", "Doña Maria",
     "Doña Maria Miponica Rice (5kg)", "NCR",
     "Official Brand Website (SL Agritech)", "https://donamaria-rice.com/", "2026-08-10",
     "Locally grown hybrid rice, marketed as premium quality by SL Agritech; DA/DTI grade confirmation pending"),
    ("impPremium", "Royal Umbrella",
     "Royal Umbrella Thai Hom Mali Jasmine Rice (5kg)", "NCR",
     "Verified NCR retailer listing (Makro / PH stores)", "https://www.makro.pro/en/p/219058-6974762614979", "2026-08-10",
     "Imported Thai Hom Mali (jasmine) fragrant rice; premium/aromatic grade per brand; DA/DTI grade mapping pending"),
]


def seed(conn: sqlite3.Connection) -> dict:
    cur = conn.cursor()
    added = {"taxes": 0, "brackets": 0}

    for kind, name, rate, flat, applies, eff, basis, src in TAXES:
        cur.execute("SELECT 1 FROM tax_component WHERE name=?", (name,))
        if cur.fetchone():
            continue
        cur.execute(
            "INSERT INTO tax_component(name,kind,rate_pct,flat_amount,applies_to,effective_date,"
            "legal_basis,source,active,verified) VALUES (?,?,?,?,?,?,?,?,1,1)",
            (name, kind, rate, flat, applies, eff, basis, src))
        added["taxes"] += 1

    for key, eff, pmin, pmax, src in BRACKETS:
        row = cur.execute("SELECT id FROM dti_category WHERE canonical_key=?", (key,)).fetchone()
        if not row:
            continue
        cat_id = row[0]
        cur.execute(
            "SELECT 1 FROM rice_price_bracket WHERE category_id=? AND effective_date=? AND source=?",
            (cat_id, eff, src))
        if cur.fetchone():
            continue
        cur.execute(
            "INSERT INTO rice_price_bracket(category_id,effective_date,price_min,price_max,source) "
            "VALUES (?,?,?,?,?)", (cat_id, eff, pmin, pmax, src))
        added["brackets"] += 1

    added["brands"] = 0
    for key, brand, pkg, loc, src, url, verified_date, note in BRANDS:
        row = cur.execute("SELECT id FROM dti_category WHERE canonical_key=?", (key,)).fetchone()
        if not row:
            continue
        cat_id = row[0]
        cur.execute("SELECT 1 FROM rice_brand WHERE category_id=? AND brand_name=? AND package=?",
                    (cat_id, brand, pkg))
        if cur.fetchone():
            continue
        cur.execute(
            "INSERT INTO rice_brand(category_id,brand_name,package,location,source,source_url,"
            "last_verified,classification_note,is_verified) VALUES (?,?,?,?,?,?,?,?,1)",
            (cat_id, brand, pkg, loc, src, url, verified_date, note))
        added["brands"] += 1

    conn.commit()
    return added


def main() -> int:
    db = _db_path()
    conn = sqlite3.connect(db)
    try:
        # ensure schema exists
        try:
            import catalog_schema  # when run from datasets/
        except ImportError:
            import sys
            sys.path.insert(0, os.path.join(PROJECT_ROOT, "datasets"))
            import catalog_schema
        catalog_schema.create_catalog_tables(conn)
        catalog_schema.seed_categories(conn)
        added = seed(conn)
        print(f"[OK] seeded verified data into {db}")
        print(f"  tax_component: +{added['taxes']}")
        print(f"  rice_price_bracket: +{added['brackets']}")
        print(f"  rice_brand: +{added.get('brands', 0)} (verified NCR branded products; other categories stay empty)")
        for t in ("tax_component", "rice_price_bracket", "rice_brand"):
            n = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            print(f"  total {t}: {n}")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())

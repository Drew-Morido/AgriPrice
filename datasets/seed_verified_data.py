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
# NOTE: the rice import TARIFF is NOT seeded here anymore — it is quarterly & price-indexed, so it
# lives in the dated `tariff_schedule` table (see TARIFF_SCHEDULE below). tax_component now holds
# only the fixed charges (VAT). consumer_price() reads the tariff from tariff_schedule by date.
TAXES = [
    ("VAT", "Value-Added Tax (rice = exempt)", 0.0, None, "all", None,
     "NIRC Sec 109 — polished/husked rice is an agricultural food product in its original state, "
     "hence VAT-EXEMPT (0%). Do not add 12% VAT to rice.",
     "NIRC Sec 109; USDA FAS"),
]

# Quarterly, price-indexed rice import tariff (EO 105 s.2025 + IAGRTA Circular No. 2025-001).
# Each CONFIRMED quarter is one dated row. Only rows we can cite are listed; future quarters are
# added by the admin once the DA posts the official certification / BOC issues the CMO.
# rate_pct, effective_start, effective_end, quarter_label, legal_basis, da_certification_url, source, verified
TARIFF_SCHEDULE = [
    (15.0, "2026-01-01", "2026-03-31", "Q1 2026",
     "EO 105 s.2025 (extends EO 62 s.2024 MFN 15%); IAGRTA Circular No. 2025-001 — quarterly "
     "price-indexed 15-35% (Vietnam 5% broken, FAO, vs Mar-2025 baseline). Q1 stayed at 15% as "
     "the increase trigger was not breached.",
     "https://www.da.gov.ph/",
     "USDA FAS RP2026-0004 (Feb 2026); PCO/PIA on EO 105", 1),
]

# FAO indicative-rate helper baseline. LEFT UNSET on purpose — the exact March-2025 FAO Vietnam
# 5% broken quote is not fabricated here; an admin sets it from FAO before the helper can suggest
# a rate. Band/step constants are law (15-35%, ±5pp per 5% move).
TARIFF_CONFIG = [
    ("fao_baseline_price", None,
     "FAO Vietnam 5% broken FOB, March 2025 baseline — [VERIFY] set from FAO GIEWS/Rice Price Update"),
    ("fao_baseline_label", "March 2025 (Vietnam 5% broken, FAO)",
     "IAGRTA Circular No. 2025-001"),
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
    added = {"taxes": 0, "brackets": 0, "tariffs": 0, "config": 0}

    # Retire any legacy single-value tariff row in tax_component — the tariff now lives in the
    # dated tariff_schedule table, so leaving it active would double-count in consumer_price().
    cur.execute("UPDATE tax_component SET active=0 WHERE kind='tariff' AND active=1")
    added["tariff_retired"] = cur.rowcount

    for kind, name, rate, flat, applies, eff, basis, src in TAXES:
        cur.execute("SELECT 1 FROM tax_component WHERE name=?", (name,))
        if cur.fetchone():
            continue
        cur.execute(
            "INSERT INTO tax_component(name,kind,rate_pct,flat_amount,applies_to,effective_date,"
            "legal_basis,source,active,verified) VALUES (?,?,?,?,?,?,?,?,1,1)",
            (name, kind, rate, flat, applies, eff, basis, src))
        added["taxes"] += 1

    # Dated quarterly tariff rows (idempotent on effective_start).
    for rate, eff_start, eff_end, qlabel, basis, cert_url, src, verified in TARIFF_SCHEDULE:
        cur.execute("SELECT 1 FROM tariff_schedule WHERE effective_start=?", (eff_start,))
        if cur.fetchone():
            continue
        cur.execute(
            "INSERT INTO tariff_schedule(rate_pct,effective_start,effective_end,quarter_label,"
            "legal_basis,da_certification_url,source,verified,approved_by,approved_at,active,notes) "
            "VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),1,?)",
            (rate, eff_start, eff_end, qlabel, basis, cert_url, src, verified, "seed",
             "Seeded from verified official sources."))
        cur.execute(
            "INSERT INTO tariff_audit(action,rate_pct,effective_start,effective_end,quarter_label,"
            "actor,detail) VALUES ('seed',?,?,?,?,?,?)",
            (rate, eff_start, eff_end, qlabel, "seed", basis))
        added["tariffs"] += 1

    # FAO helper config (idempotent on key; do not overwrite an admin-set value).
    for key, value, source in TARIFF_CONFIG:
        cur.execute("SELECT 1 FROM tariff_config WHERE key=?", (key,))
        if cur.fetchone():
            continue
        cur.execute(
            "INSERT INTO tariff_config(key,value,source,updated_at) VALUES (?,?,?,datetime('now'))",
            (key, value, source))
        added["config"] += 1

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
        print(f"  tax_component: +{added['taxes']} (legacy tariff rows retired: {added.get('tariff_retired', 0)})")
        print(f"  tariff_schedule: +{added['tariffs']} (dated quarterly tariff rows)")
        print(f"  tariff_config: +{added['config']}")
        print(f"  rice_price_bracket: +{added['brackets']}")
        print(f"  rice_brand: +{added.get('brands', 0)} (verified NCR branded products; other categories stay empty)")
        for t in ("tax_component", "tariff_schedule", "rice_price_bracket", "rice_brand"):
            n = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            print(f"  total {t}: {n}")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())

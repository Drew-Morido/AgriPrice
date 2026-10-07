"""
AgriPricePH — record verified traditional/variety names for catalog brands.

Adds rice_brand.variety_names / variety_source (if missing) and fills them ONLY for brands whose
variety is confirmed by a retailer listing (URL kept in variety_source). Everything else is left
NULL on purpose: since the DA's 2018 labeling rule, milled rice is sold by classification and many
packs carry no variety name at all, so a name that cannot be sourced is not invented. Brands whose
variety already comes from the recorded pack text (e.g. "Sinandomeng") need no entry here.

Idempotent — safe to re-run:   cd datasets && py -3.13 seed_brand_varieties.py
"""

import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths  # noqa: E402  (datasets/scripts/paths.py: every datasets/ location)
import sqlite3

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = paths.DB_PATH

# (category canonical_key, brand_name) -> (variety_names, source)
VERIFIED = {
    ("locPremium", "Lion Ivory"): (
        "Sinandomeng",
        "https://www.landers.ph/food-cupboard/lion-ivory-grains-classic-sinandomeng-special-rice-25kg-112967-26660",
    ),
    ("locPremium", "Angelica"): (
        "Angelica (NSIC Rc 122)",
        "https://www.pinoyrice.com/wp-content/uploads/rice-varieties/ANGELICA.html",
    ),
    ("impWellMilled", "Master Chef"): (
        "Thai Long Grain White Rice",
        "https://masterchefph.com/products/master-chef-premium-thai-long-grain-rice-25kg-fried-rice-maalsa-buhaghag-5-broken",
    ),
    ("locRegular", "Binhi Alsa"): (
        "Long Grain Soft Rice",
        "https://shopee.ph/25kg-Binhi-Rice-Soft-and-Long-Grain-i.192655827.56861559825",
    ),
    ("locRegular", "NFA"): (
        "NFA well-milled rice",
        "https://www.da.gov.ph/wp-content/uploads/2021/01/Price-Monitoring-January-22-2021.pdf",
    ),
    ("locPremium", "Ganador"): (
        "Long Grain Rice",
        "https://www.landers.ph/food-cupboard/ganador-oliver-well-milled-rice-5kg-112962-22640",
    ),
    ("locPremium", "Buko Pandan"): (
        "RC 160 (scented)",
        "https://www.lazada.com.ph/products/quality-premium-rice-buko-pandan-rc-160-scented-rice-bigas-available-in-25kg-10kg-5kg-i5026327931.html",
    ),
}

# Imported Thai white rice sold by broken-grain spec rather than a named cultivar: the product's own
# recorded pack text ("Thai 5% broken" / "Whole Grain Rice 5% Thai"), shown in a clean form.
_THAI_SPEC = ("Thai Rice (5% broken)",
              "datasets/Rice_Brand_Final_Mapping.xlsx (recorded pack text); sold by spec, not a named cultivar")
for _b in ("Master Chef", "Planters", "Royal Peregrine", "Royal Sheep"):
    VERIFIED[("impPremium", _b)] = _THAI_SPEC


def ensure_columns(conn):
    cols = [r[1] for r in conn.execute("PRAGMA table_info(rice_brand)")]
    for col in ("variety_names", "variety_source"):
        if col not in cols:
            conn.execute(f"ALTER TABLE rice_brand ADD COLUMN {col} TEXT")


def main():
    conn = sqlite3.connect(DB_PATH)
    try:
        ensure_columns(conn)
        n = 0
        for (cat_key, brand), (names, source) in VERIFIED.items():
            cur = conn.execute(
                "UPDATE rice_brand SET variety_names=?, variety_source=? "
                "WHERE brand_name=? AND category_id=(SELECT id FROM dti_category WHERE canonical_key=?)",
                (names, source, brand, cat_key))
            n += cur.rowcount
        conn.commit()
        print(f"Updated {n} brand row(s).")
    finally:
        conn.close()


if __name__ == "__main__":
    main()

"""
AgriPricePH — split multi-product brands into one catalog row (card) per product.

Phase 1 merged a brand's several products in the same category into ONE row (e.g. Henri & Isabelle:
"4 varieties: Black Rice, Brown Rice, …") priced as the range across them. Each product is its own
rice with its own price, so this script replaces those merged rows with one row per product, using
the per-product prices the source workbook kept on its "Consolidated SKU Detail" sheet
(datasets/Rice_Brand_Final_Mapping.xlsx — "Nothing was discarded").

For every merged row it:
  * adds one active rice_brand row per product (package = the product's variety; variety_names and
    variety_source record where the name came from; notes carry that product's own source price);
  * sets that product's variance weight the same way seed_brand_weights.py does
    (weight = (product price - category base) / base, sample_n = 1, sample_date = 2026-09-04);
  * soft-deactivates the merged row (kept for audit/history — never deleted).

Products keep the category they were filed under — the workbook does not classify individual
products separately, and this script does not reclassify anything.

Idempotent (a product that already exists is skipped; a merged row is only deactivated once).
Run:  py -3.13 datasets/split_multi_sku_brands.py [--dry-run]
"""

from __future__ import annotations

import argparse
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths  # noqa: E402  (datasets/scripts/paths.py: every datasets/ location)
import re
import shutil
import sys
from datetime import datetime

import openpyxl

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # datasets/scripts/ -> root
sys.path.insert(0, os.path.join(PROJECT_ROOT, "api"))
import catalog_service as cs  # noqa: E402

XLSX_PATH = os.path.join(paths.BRAND_DIR, "Rice_Brand_Final_Mapping.xlsx")
SHEET = "Consolidated SKU Detail"
SURVEY_DATE = "2026-09-04"
ACTOR = "split_multi_sku_brands.py"
VARIETY_SOURCE = "datasets/Rice_Brand_Final_Mapping.xlsx — Consolidated SKU Detail"


def _key(cell: str) -> str:
    return str(cell or "").split("—", 1)[0].split("–", 1)[0].strip()


def read_skus() -> list[dict]:
    wb = openpyxl.load_workbook(XLSX_PATH, data_only=True)
    ws = wb[SHEET]
    rows = list(ws.iter_rows(values_only=True))
    hdr = next(i for i, r in enumerate(rows) if r and str(r[0] or "").strip() == "Brand")
    out = []
    for r in rows[hdr + 1:]:
        if not r or not str(r[0] or "").strip() or r[3] in (None, ""):
            continue
        out.append({"brand": str(r[0]).strip(), "key": _key(r[1]),
                    "variety": re.sub(r"\s+", " ", str(r[2] or "")).strip(), "price": float(r[3])})
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    skus = read_skus()
    conn = cs._connect()
    try:
        cs._ensure_brand_image(conn)   # makes sure variety_names / variety_source exist
        merged = {}
        for r in conn.execute(
                "SELECT b.*, c.canonical_key AS ckey FROM rice_brand b JOIN dti_category c "
                "ON c.id=b.category_id WHERE b.active=1 AND b.classification_note LIKE '% SKUs from this brand%'"):
            merged[(r["ckey"], r["brand_name"])] = dict(r)

        if not args.dry_run:
            backup = paths.backup_path("pre-split")
            shutil.copy2(cs._db_path(), backup)
            print(f"Backup: {os.path.basename(backup)}")

        added = skipped = 0
        for (ckey, brand), old in merged.items():
            mine = [s for s in skus if s["brand"] == brand and s["key"] == ckey]
            if not mine:
                print(f"! no per-product prices for {brand} / {ckey} — left merged")
                continue
            base, _ = cs._latest_base_price(conn, ckey)
            w_old = conn.execute("SELECT sample_locations FROM brand_price_adjustment WHERE brand_id=?",
                                 (old["id"],)).fetchone()
            for s in mine:
                weight = round((s["price"] - base) / base * 100.0, 2)
                print(f"  {ckey:12} {brand:18} {s['variety']:30} ₱{s['price']:<7} weight {weight:+.1f}%")
                if args.dry_run:
                    continue
                res = cs.add_brand(
                    ckey, brand, package=s["variety"], location=old["location"], source=old["source"],
                    source_url=old["source_url"], last_verified=old["last_verified"], classification_note=None,
                    notes=f"Source price: ₱{s['price']:.2f}/kg", verification_status=old["verification_status"],
                    actor=ACTOR)
                if not res.get("ok"):
                    skipped += 1
                    print(f"    skipped: {res.get('error')}")
                    continue
                bid = res["brand_id"]
                conn.execute("UPDATE rice_brand SET variety_names=?, variety_source=? WHERE id=?",
                             (s["variety"], VARIETY_SOURCE, bid))
                conn.commit()
                wres = cs.set_brand_weight(
                    bid, weight, sample_date=SURVEY_DATE,
                    sample_locations=(w_old["sample_locations"] if w_old else old["location"]), sample_n=1,
                    source_notes=f"Single field-survey price for this product (₱{s['price']:.2f}/kg), split out of the merged "
                                 f"'{brand}' row. See datasets/Rice_Brand_Final_Mapping.xlsx.",
                    actor=ACTOR)
                if not wres.get("ok"):
                    print(f"    weight rejected: {wres.get('error')}")
                added += 1
            if not args.dry_run:
                cs.deactivate_brand(old["id"], active=False, actor=ACTOR)
        print(f"{'Would add' if args.dry_run else 'Added'} {added if not args.dry_run else sum(len([s for s in skus if s['brand']==b and s['key']==k]) for (k,b) in merged)} product rows; "
              f"deactivated {len(merged)} merged rows; skipped {skipped}.")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

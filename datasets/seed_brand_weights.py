"""
AgriPricePH — seed brand variance weights ("patong", Phase 2) from the real survey price in
`Rice_Brand_Final_Mapping.xlsx`'s "30-Day Price Log" sheet.

Important honesty note about that sheet: despite the name, it is NOT 30 independent daily
observations. Its own header says so — "Prices were captured once at the end of this window
[Aug 6 - Sep 4, 2026], not re-checked daily, so each day repeats that same observed price...
Average, Min and Max are therefore all equal to the survey price." It is ONE real, sourced
price point per brand (the same number as "Final Brand Mapping"'s "Price per Kilo" column,
just midpointed), copied across 30 columns as a template for future daily tracking.

So this script seeds each brand's weight as ONE observation, not thirty:
    weight_pct = (survey_price - category_base_price) / category_base_price * 100
    sample_n   = 1          (never 30 — that would overclaim the evidence)
    sample_date = 2026-09-04 (the sheet's actual single survey date)

Skips (does not overwrite) any brand that already has a weight — an admin's manual edit is never
silently clobbered by re-running this script. Every write still goes through
catalog_service.set_brand_weight(), so it is validated against the same sanity band
(BRAND_WEIGHT_BAND_MIN/MAX) and logged to brand_weight_audit like any other weight change.

Run:  py -3.13 datasets/seed_brand_weights.py            # seed
      py -3.13 datasets/seed_brand_weights.py --dry-run   # show what would happen, write nothing
      py -3.13 datasets/seed_brand_weights.py --force     # overwrite existing weights too
"""

from __future__ import annotations

import argparse
import os
import sys

import openpyxl

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API_DIR = os.path.join(PROJECT_ROOT, "api")
XLSX_PATH = os.path.join(PROJECT_ROOT, "datasets", "Rice_Brand_Final_Mapping.xlsx")
SHEET_NAME = "30-Day Price Log"
SURVEY_DATE = "2026-09-04"  # the sheet's own "Day 30" / final survey date

sys.path.insert(0, API_DIR)
import catalog_service as cs  # noqa: E402


def _split_category(cell: str) -> str:
    s = str(cell or "").strip()
    for sep in ("—", "–", "-"):
        if sep in s:
            return s.split(sep, 1)[0].strip()
    return s


def read_survey_rows(xlsx_path: str = XLSX_PATH) -> list[dict]:
    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    if SHEET_NAME not in wb.sheetnames:
        raise ValueError(f"Sheet '{SHEET_NAME}' not found. Sheets: {wb.sheetnames}")
    ws = wb[SHEET_NAME]
    all_rows = list(ws.iter_rows(values_only=True))

    header_idx = next((i for i, r in enumerate(all_rows)
                        if r and str(r[0] or "").strip() == "Segment"), None)
    if header_idx is None:
        raise ValueError("Could not find the header row (first cell 'Segment').")
    header = all_rows[header_idx]
    avg_idx = next((i for i, c in enumerate(header) if str(c or "").startswith("Average")), None)
    if avg_idx is None:
        raise ValueError("Could not find the 'Average (₱)' column.")

    out = []
    for r in all_rows[header_idx + 1:]:
        if not r or not str(r[0] or "").strip():
            continue
        canonical_key = _split_category(r[1])
        brand_name = str(r[2] or "").strip()
        package = str(r[3] or "").strip() or None
        location = str(r[4] or "").strip() or None
        survey_price = r[avg_idx]
        if not brand_name or not canonical_key or survey_price in (None, ""):
            continue
        out.append({
            "canonical_key": canonical_key, "brand_name": brand_name, "package": package,
            "location": location, "survey_price": float(survey_price),
        })
    return out


def find_brand_id(conn, canonical_key: str, brand_name: str, package: str | None) -> int | None:
    row = conn.execute(
        "SELECT b.id FROM rice_brand b JOIN dti_category c ON c.id=b.category_id "
        "WHERE c.canonical_key=? AND b.brand_name=? AND (b.package IS ? OR b.package=?)",
        (canonical_key, brand_name, package, package)).fetchone()
    return row[0] if row else None


def has_weight(conn, brand_id: int) -> bool:
    return conn.execute(
        "SELECT 1 FROM brand_price_adjustment WHERE brand_id=?", (brand_id,)).fetchone() is not None


def main() -> int:
    ap = argparse.ArgumentParser(description="Seed brand variance weights from the 30-Day Price Log's survey price")
    ap.add_argument("--dry-run", action="store_true", help="compute and print, write nothing")
    ap.add_argument("--force", action="store_true", help="overwrite brands that already have a weight")
    ap.add_argument("--xlsx", default=XLSX_PATH)
    args = ap.parse_args()

    rows = read_survey_rows(args.xlsx)
    conn = cs._connect()

    seeded, skipped_existing, skipped_no_brand, skipped_no_base, rejected = [], [], [], [], []
    try:
        for row in rows:
            bid = find_brand_id(conn, row["canonical_key"], row["brand_name"], row["package"])
            if bid is None:
                skipped_no_brand.append(row); continue
            if not args.force and has_weight(conn, bid):
                skipped_existing.append(row); continue

            base, _src = cs._latest_base_price(conn, row["canonical_key"])
            if base is None:
                skipped_no_base.append(row); continue

            weight_pct = round((row["survey_price"] - base) / base * 100.0, 2)
            row["base_price"], row["weight_pct"] = base, weight_pct

            if args.dry_run:
                seeded.append(row); continue

            result = cs.set_brand_weight(
                brand_id=bid, weight_pct=weight_pct, sample_date=SURVEY_DATE,
                sample_locations=row["location"], sample_n=1,
                source_notes=("Single field-survey price point (not a 30-day series — see "
                               "datasets/Rice_Brand_Final_Mapping.xlsx '30-Day Price Log' sheet "
                               "note) vs. the category's base price on the same date."),
                actor="seed_brand_weights.py")
            if result.get("ok"):
                seeded.append(row)
            else:
                row["error"] = result.get("error")
                rejected.append(row)
    finally:
        conn.close()

    mode = "[DRY RUN] " if args.dry_run else ""
    print(f"{mode}Parsed {len(rows)} survey rows from '{SHEET_NAME}'.")
    print(f"{mode}{'Would seed' if args.dry_run else 'Seeded'}: {len(seeded)}")
    for r in sorted(seeded, key=lambda r: -abs(r["weight_pct"])):
        print(f"  {r['canonical_key']:14} {r['brand_name']:20} "
              f"survey=₱{r['survey_price']:<8} base=₱{r['base_price']:<7} weight={r['weight_pct']:+.1f}%")
    if rejected:
        print(f"REJECTED by the sanity band ({cs.BRAND_WEIGHT_BAND_MIN:.0f}% to "
              f"{cs.BRAND_WEIGHT_BAND_MAX:.0f}%): {len(rejected)}")
        for r in rejected:
            print(f"  {r['canonical_key']:14} {r['brand_name']:20} weight={r['weight_pct']:+.1f}% — {r['error']}")
    if skipped_existing:
        print(f"Skipped (already has a weight — use --force to overwrite): {len(skipped_existing)}")
        for r in skipped_existing:
            print(f"  {r['canonical_key']:14} {r['brand_name']}")
    if skipped_no_brand:
        print(f"Skipped (no matching catalog brand found): {len(skipped_no_brand)}")
        for r in skipped_no_brand:
            print(f"  {r['canonical_key']:14} {r['brand_name']} ({r['package']})")
    if skipped_no_base:
        print(f"Skipped (category has no base price yet): {len(skipped_no_base)}")
        for r in skipped_no_base:
            print(f"  {r['canonical_key']:14} {r['brand_name']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""
AgriPricePH — apply the DA-AMAS "Weekly Prevailing Retail Price of Commercial Rice in Selected
NCR Wet Markets" workbook (user-supplied, `WEEKLY-PREVAILING-RETAIL-PRICE-RICE-2020-2025.xlsx`)
on top of `retail_prices`, extending correction coverage back into 2021-2023 — a window that
`apply_da_corrections.py` explicitly left untouched because no independently-checkable DA source
was reachable for it at the time (DA's own public PDF archive only goes back to 2023-08-21).

Coverage — deliberately NOT the file's full 2020-2025 span:
  - Only 2021-01-04 through 2023-12-24 is applied here. 2023-12-25 onward is already covered by
    `da_verified_retail_prices_2023-2025.csv` (individual DA bulletin PDFs, dated per-day —
    strictly higher precision than this file's weekly summary), so this script never overwrites
    that window and the two corrections never conflict. Spot-checked: this file's own last
    in-scope week (2023-12-25..12-29 — excluded) lines up exactly, date-for-date, with the first
    week of the existing correction, which independently confirms the week-alignment algorithm
    below is correct; the two sources' *values* differ by ~1 peso there (e.g. locRegular 52.00
    here vs 50.95 in the bulletin-sourced correction) — expected, since they're different DA
    products, not the same survey re-published, and is exactly why the more granular per-bulletin
    source wins wherever it exists.
  - The 2020 sheet is NOT used at all: its own header has 54 week-columns for a year that only
    has 52 real Monday-starting weeks (some month's "Wk 1..Wk N" labeling has 1-2 extra columns
    we have no reliable way to identify), which `parse_da_amas_weekly.py`'s validation caught
    because the resulting overflow silently collided, date range-for-date range, with the real
    first two weeks of 2021. Rather than guess which column is spurious, all of 2020 is skipped —
    the same call made earlier for OCR-unreliable scanned PDFs. 2015-2020 remains exactly as
    `apply_da_corrections.py` already left it: unverifiable, untouched.
  - 2024-2025 in this file is deliberately NOT used even where `da_verified_retail_prices` has
    gaps: this file's own 2025 sheet shows "Other Special Rice" (imported) frozen at exactly
    60.00 for 42 of 52 weeks and "Premium" (imported) frozen for 10 trailing weeks, coinciding
    with DA's March-2025 reporting-format change. Whether that reflects a genuinely low-variance
    reference price or a column DA-AMAS stopped actively updating for this particular yearly-
    summary file could not be confirmed either way, so none of this file's 2024-2025 data was
    used — that window is left exactly as it already stands (mostly the higher-quality individual
    bulletin correction, with its own disclosed gaps).
  - Within 2021-2023, a week/category cell that the source itself marks "-" (not surveyed) is
    left alone, never invented — see `parse_da_amas_weekly.py`.
  - Weekly values are applied to all 7 calendar days of their Monday-Friday survey week
    (weekend days included, carried from the same week's value) since DA does not survey on
    weekends — the same convention already used for the "Weekly Average Price" rows in the
    existing correction, several of which also span into Saturday.

See `parse_da_amas_weekly.py` for the parser and its date-alignment algorithm/validation.

Idempotent: re-running just re-applies the same CSV.

Run:  py -3.13 datasets/apply_da_amas_weekly_corrections.py
"""

from __future__ import annotations

import os
import shutil
import sqlite3
from datetime import datetime

import pandas as pd

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "agriprice_database.db")
CORRECTIONS_CSV = os.path.join(BASE_DIR, "da_amas_weekly_corrections_2020-2023.csv")

# canonical column -> the exact column name used in the retail_prices table (matches
# apply_da_corrections.py's DB_COLS exactly, including its "Imprted Premium" typo)
DB_COLS = {
    "impSpecial": "Imported Special",
    "impPremium": "Imprted Premium",  # sic — matches the existing (typo'd) DB schema
    "impWellMilled": "Imported Well-Milled",
    "impRegular": "Imported Regular",
    "locSpecial": "Local Special",
    "locPremium": "Local Premium",
    "locWellMilled": "Local Well-Milled",
    "locRegular": "Local Regular",
}


def apply_corrections(db_path: str = DB_PATH, csv_path: str = CORRECTIONS_CSV,
                       verbose: bool = True, backup: bool = True) -> dict:
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"Database not found at {db_path}. Run datasets/script.py first.")
    if not os.path.exists(csv_path):
        raise FileNotFoundError(
            f"Corrections file not found at {csv_path}. Run parse_da_amas_weekly.py's export step first."
        )

    if backup:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_path = db_path + f".backup-pre-daamas-{stamp}"
        shutil.copy2(db_path, backup_path)
        if verbose:
            print(f"[OK] backed up database to {backup_path}")

    corrected = pd.read_csv(csv_path)
    corrected["Date"] = pd.to_datetime(corrected["Date"])

    conn = sqlite3.connect(db_path)
    orig = pd.read_sql("SELECT * FROM retail_prices", conn)
    orig["Date"] = pd.to_datetime(orig["Date"])

    rows_touched = 0
    cells_changed = 0
    for _, row in corrected.iterrows():
        mask = orig["Date"] == row["Date"]
        if not mask.any():
            continue
        idx = orig.index[mask][0]
        row_changed = False
        for src_col, db_col in DB_COLS.items():
            new_val = row.get(src_col)
            if pd.isna(new_val):
                continue
            old_val = orig.at[idx, db_col]
            new_val = round(float(new_val), 2)
            if pd.isna(old_val) or round(float(old_val), 2) != new_val:
                cells_changed += 1
                row_changed = True
            orig.at[idx, db_col] = new_val
        if row_changed:
            rows_touched += 1

    orig["Date"] = orig["Date"].dt.strftime("%Y-%m-%d")
    orig.to_sql("retail_prices", conn, if_exists="replace", index=False)
    conn.commit()
    conn.close()

    if verbose:
        print(f"[OK] applied DA-AMAS weekly-file prices to {db_path}")
        print(f"  rows touched: {rows_touched} / {len(corrected)} candidate days")
        print(f"  cells changed this run: {cells_changed}")
        print(f"  coverage: {corrected['Date'].min().date()} to {corrected['Date'].max().date()}")

    return {"rows_touched": rows_touched, "cells_changed": cells_changed, "candidate_days": len(corrected)}


if __name__ == "__main__":
    apply_corrections()

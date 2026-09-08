"""
AgriPricePH — apply verified DA (Department of Agriculture) bulletin prices on top of
`retail_prices`, replacing the original file's values for the dates we could actually confirm.

Background: `retail_prices` (loaded verbatim from DATASETS_RETAIL_PRICE_2015_2025.xlsx by
script.py) does not reliably match DA's own published bulletins — spot-checks found differences
of roughly ₱1 to ₱20/kg, in both directions, on real dates checked against real DA PDFs. This
script replaces the table's values for every date we could fetch and read a real DA bulletin for,
and leaves every other date untouched (do NOT invent a number for a date with no bulletin).

Coverage — NOT the full 2015-2025 span, on purpose:
  - DA's own public archive only goes back to 2023-08-21 (Weekly Average Price) and 2025-03-01
    (Daily Price Index) — https://www.da.gov.ph/price-monitoring/. 2015 through mid-2023 has no
    accessible bulletin to check against at all; those rows are left exactly as the original file
    had them.
  - Within the archived window, only bulletins with a genuine text layer (not a scanned image)
    were used — a deterministic regex extraction, not OCR, so every value here is traceable to
    an exact DA PDF, not a guess. Many "Weekly Average Price" bulletins from Sep 2023-Feb 2025
    are scanned images with inconsistent table layouts across that period (DA changed the visual
    template more than once); OCR on those produced occasional digit errors (e.g. "7.13" for what
    should read "47.13") that could not be told apart from correct values without checking each
    one by hand, so that stretch was deliberately excluded rather than risk silently corrupting
    the dataset. See `datasets/da_verified_retail_prices_2023-2025.csv` for exactly which dates
    made it in (source column tags each row Daily Price Index vs Weekly Average Price) — 457
    calendar days, 2023-12-25 through 2025-12-31, out of the ~860 in the theoretically-verifiable
    window.
  - A handful of individual cells were "n/a" in DA's own bulletin (e.g. imported Regular-Milled
    genuinely wasn't reported some weeks). Those are forward/back-filled from the nearest other
    *verified* day in this same correction set only — never invented, and disclosed here exactly
    like `import_2026.py`'s existing `.ffill()` for isolated sheet gaps.

Idempotent: re-running just re-applies the same CSV; safe on a fresh `script.py` setup too (see
the auto-run hook there).

Run:  py -3.13 datasets/apply_da_corrections.py
"""

from __future__ import annotations

import os
import sqlite3

import pandas as pd

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "agriprice_database.db")
CORRECTIONS_CSV = os.path.join(BASE_DIR, "da_verified_retail_prices_2023-2025.csv")

# canonical column -> the exact column name used in the retail_prices table
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


def apply_corrections(db_path: str = DB_PATH, csv_path: str = CORRECTIONS_CSV, verbose: bool = True) -> dict:
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"Database not found at {db_path}. Run datasets/script.py first.")
    if not os.path.exists(csv_path):
        raise FileNotFoundError(f"Corrections file not found at {csv_path}.")

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
        print(f"[OK] applied DA-verified prices to {db_path}")
        print(f"  rows touched: {rows_touched} / {len(corrected)} verified dates")
        print(f"  cells changed this run: {cells_changed}")
        print(f"  coverage: {corrected['Date'].min().date()} to {corrected['Date'].max().date()}"
              f" ({len(corrected)} of ~860 calendar days in the theoretically-verifiable window)")

    return {"rows_touched": rows_touched, "cells_changed": cells_changed, "verified_dates": len(corrected)}


if __name__ == "__main__":
    apply_corrections()

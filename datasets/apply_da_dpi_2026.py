"""
AgriPricePH — apply verified DA "Daily Price Index" (NCR) prices for 2026 onto `WS_rice_price`.

Why this matters more than the earlier corrections: the DPI era (DA switched from weekly to daily
bulletins around March 2025) is the ONLY period whose day-to-day dynamics the forecast model can
actually learn from — the pre-2025 history is weekly reports forward-filled onto a daily grid, so
it contains no genuine daily movement. Every extra verified day here directly enlarges the window
the mean-reversion coefficient is fitted on (`model/mean_reversion.py`), which was the binding
constraint on model skill.

Coverage: 155 consecutive days, 2026-04-01 to 2026-09-02, no calendar gaps.

Provenance and how it was validated before any of it was written:
  - 2026-04-01..05-31 (61 days) parsed directly from the DA DPI bulletin PDFs
    (`parse_da_dpi_pdfs.py`), which are text-layer — deterministic extraction, no OCR.
  - 2026-06-01..09-02 (94 days) from the user's DPI workbook. Checked, not assumed:
      * exact-linear-midpoint share 12.5%, against 6.7% for known-real daily data and 75-82%
        for known-interpolated series — i.e. it behaves like real observations;
      * on the 3 days where it overlaps the PDFs (2026-05-29..31) it matches to the centavo.
  - Where the PDFs and the workbook overlap, the PDF wins (primary source).

REJECTED for comparison, and why it matters that this was checked: a companion
`Rice_Prices_MarApr_2025_Daily.xlsx` scored 78.6% on the same midpoint test — it is linear
interpolation between weekly reports, not daily observation, so it was not ingested. Interpolated
rows are worse than absent rows here: a straight line is trivially forecastable, so they would
raise measured skill while lowering real forecasting ability.

Writes into `WS_rice_price` (the 2026 table; `retail_prices` ends 2025-12-31), tagging `Source`
so scraper estimates can still be told apart from bulletin-verified values.

Idempotent. Run:  py -3.13 datasets/apply_da_dpi_2026.py
"""

from __future__ import annotations

import os
import shutil
import sqlite3
from datetime import datetime

import pandas as pd

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "agriprice_database.db")
CSV_PATH = os.path.join(BASE_DIR, "da_dpi_verified_2026.csv")

# canonical key -> WS_rice_price column
DB_COLS = {
    "impSpecial": "Imported Special",
    "impPremium": "Imported Premium",
    "impWellMilled": "Imported Well Milled",
    "impRegular": "Imported Regular Milled",
    "locSpecial": "Local Special",
    "locPremium": "Local Premium",
    "locWellMilled": "Local Well Milled",
    "locRegular": "Local Regular Milled",
}
SOURCE_TAG = "da_dpi_verified"


def apply_corrections(db_path: str = DB_PATH, csv_path: str = CSV_PATH,
                      verbose: bool = True, backup: bool = True) -> dict:
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"Database not found at {db_path}.")
    if not os.path.exists(csv_path):
        raise FileNotFoundError(f"Verified DPI file not found at {csv_path}.")

    new = pd.read_csv(csv_path)
    new["Date"] = pd.to_datetime(new["Date"])

    if backup:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        dst = db_path + f".backup-pre-dpi2026-{stamp}"
        shutil.copy2(db_path, dst)
        if verbose:
            print(f"[OK] backed up database to {dst}")

    conn = sqlite3.connect(db_path)
    cur = pd.read_sql('SELECT * FROM "WS_rice_price"', conn)
    cur["_d"] = pd.to_datetime(cur["Date"], format="%m/%d/%Y", errors="coerce")

    rows_updated = rows_inserted = cells = 0
    for _, r in new.iterrows():
        d = r["Date"]
        vals = {}
        for key, col in DB_COLS.items():
            v = r.get(key)
            if pd.notna(v):
                vals[col] = round(float(v), 2)
        if not vals:
            continue
        hit = cur.index[cur["_d"] == d]
        if len(hit):
            i = hit[0]
            for col, v in vals.items():
                old = pd.to_numeric(pd.Series([cur.at[i, col]]), errors="coerce").iloc[0]
                if pd.isna(old) or round(float(old), 2) != v:
                    cells += 1
                cur.at[i, col] = v
            cur.at[i, "Source"] = SOURCE_TAG
            rows_updated += 1
        else:
            rec = {"Date": d.strftime("%m/%d/%Y"), "Source": SOURCE_TAG}
            rec.update(vals)
            cur = pd.concat([cur, pd.DataFrame([rec])], ignore_index=True)
            cells += len(vals)
            rows_inserted += 1

    cur["_d"] = pd.to_datetime(cur["Date"], format="%m/%d/%Y", errors="coerce")
    cur = cur.sort_values("_d").drop(columns=["_d"])
    cur.to_sql("WS_rice_price", conn, if_exists="replace", index=False)
    conn.commit()
    conn.close()

    if verbose:
        print(f"[OK] applied verified DA DPI prices to {db_path}")
        print(f"  days updated: {rows_updated} | days inserted: {rows_inserted} | cells changed: {cells}")
        print(f"  coverage: {new['Date'].min().date()} to {new['Date'].max().date()} ({len(new)} days)")

    return {"updated": rows_updated, "inserted": rows_inserted, "cells": cells}


if __name__ == "__main__":
    apply_corrections()

"""
AgriPricePH — apply real DA "Bantay Presyo"/"Price Watch"/"Price Monitoring" bulletin PDFs
(user-supplied folder, 2018-2021) on top of `retail_prices`, extending verified correction
coverage into the 2015 - Jan 2021 window that was, until now, entirely untouched (no reachable
DA source went back that far).

Coverage: 110 individual calendar days, 2019-10-01 through 2021-10-22 (16 days in 2019, 46 in
2020, 48 in 2021) — see `parse_da_bantay_presyo_pdfs.py`'s docstring for exactly which of the
177 supplied PDFs were usable and why the rest were not (60 use an older, incompatible template
with no imported/local rice split; a further 13 are per-market summary posters or a single
unparseable infographic).

Where a corrected day falls inside 2021-01-04 through 2023-12-24, it overlaps the already-applied
`apply_da_amas_weekly_corrections.py` — that correction came from a weekly *summary* spreadsheet,
while these are individual dated bulletin PDFs, so the per-bulletin figure here wins (this
script runs after that one). The overlap was cross-checked before applying: 246 overlapping
cells, median difference ₱0.00, mean ₱0.31, max ₱4.00 — the two independent DA sources agree
closely, which is itself a good sign both are genuine.

For 2019-2020 (previously fully unverified original-import data), the same spot-check found a
median ₱1.50 difference (mean ₱2.54, max ₱12.00) versus the original uncorrected values — in
line with the ₱1-20/kg discrepancies already documented in `apply_da_corrections.py` for the
2023-2025 window, i.e. consistent with real bulletin data, not a parsing artifact.

A cell the source PDF didn't report that day (e.g. imported Regular-Milled, missing on 84.5% of
these particular days — DA itself frequently didn't report it) is left alone, never invented.

This reads from `da_bantay_presyo_corrections_2019-2021.csv`, a permanent snapshot of
`parse_da_bantay_presyo_pdfs.py`'s output — like the other two correction scripts in this folder,
it does NOT re-read the source PDFs at apply time (they live outside the repo, in the user's own
Downloads folder, and won't be present on another machine/deployment). Re-run
`parse_da_bantay_presyo_pdfs.py` and regenerate that CSV if the source folder gets more files.

Idempotent: re-running just re-applies the same CSV.

Run:  py -3.13 datasets/apply_da_bantay_presyo_corrections.py
"""

from __future__ import annotations

import os
import shutil
import sqlite3
from datetime import datetime

import pandas as pd

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "agriprice_database.db")
CORRECTIONS_CSV = os.path.join(BASE_DIR, "da_bantay_presyo_corrections_2019-2021.csv")

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
            f"Corrections file not found at {csv_path}. Run parse_da_bantay_presyo_pdfs.py's export step first."
        )

    corrected = pd.read_csv(csv_path)
    corrected["Date"] = pd.to_datetime(corrected["Date"])
    rows = {
        row["Date"].strftime("%Y-%m-%d"): {c: (None if pd.isna(row[c]) else float(row[c])) for c in DB_COLS}
        for _, row in corrected.iterrows()
    }
    if not rows:
        if verbose:
            print("[skip] no rows in corrections CSV")
        return {"rows_touched": 0, "cells_changed": 0, "candidate_days": 0}

    if backup:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_path = db_path + f".backup-pre-bantaypresyo-{stamp}"
        shutil.copy2(db_path, backup_path)
        if verbose:
            print(f"[OK] backed up database to {backup_path}")

    conn = sqlite3.connect(db_path)
    orig = pd.read_sql("SELECT * FROM retail_prices", conn)
    orig["Date"] = pd.to_datetime(orig["Date"])

    rows_touched = 0
    cells_changed = 0
    for date_iso, values in rows.items():
        mask = orig["Date"] == pd.Timestamp(date_iso)
        if not mask.any():
            continue
        idx = orig.index[mask][0]
        row_changed = False
        for src_col, db_col in DB_COLS.items():
            new_val = values.get(src_col)
            if new_val is None:
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
        print(f"[OK] applied DA Bantay Presyo bulletin prices to {db_path}")
        print(f"  rows touched: {rows_touched} / {len(rows)} candidate days")
        print(f"  cells changed this run: {cells_changed}")
        dates = sorted(rows.keys())
        print(f"  coverage: {dates[0]} to {dates[-1]} ({len(rows)} individual days)")

    return {"rows_touched": rows_touched, "cells_changed": cells_changed, "candidate_days": len(rows)}


if __name__ == "__main__":
    apply_corrections()

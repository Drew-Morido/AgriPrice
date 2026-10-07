"""
AgriPricePH — load the monthly economic factors (2015 onward) into the database:

    MACRO_core_inflation  PSA OpenSTAT core inflation, year-on-year % (Date, core_cpi, core_inflation)
    MACRO_world_rice      World Bank Pink Sheet rice export prices, USD/t (Date, viet5, thai5)

    cd datasets/scripts && py -3.13 import_macro_factors.py

Backs up the database first, then writes both tables (one row per month, dated the month's first day; the model
uses each figure only from the 15th of the following month — data_pipeline.MONTHLY_RELEASE_LAG) and exports them to
psa_core_inflation_monthly.csv and worldbank_rice_monthly.csv. Safe to re-run. The scrape cycle refreshes the same
tables automatically (tools/macro_factors.py).
"""

from __future__ import annotations

import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths  # noqa: E402  (datasets/scripts/paths.py: every datasets/ location)
import shutil
import sqlite3
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, paths.TOOLS_DIR)
import macro_factors as mf  # noqa: E402

DB_PATH = paths.DB_PATH
CSV = {"MACRO_core_inflation": "psa_core_inflation_monthly.csv", "MACRO_world_rice": "worldbank_rice_monthly.csv"}


def main() -> int:
    frames = mf.fetch()
    conn = sqlite3.connect(DB_PATH)
    try:
        problems = mf.validate(frames, mf.stored_months(conn))
        if problems:
            for p in problems:
                print("Refused:", p)
            return 1
        backup = paths.backup_path("pre-macro")
        shutil.copy2(DB_PATH, backup)
        print(f"Backup: {os.path.basename(backup)}")
        mf.write(conn, frames)
    finally:
        conn.close()
    for name, df in frames.items():
        df.assign(Date=df["Date"].dt.strftime("%Y-%m-%d"), Source=mf.TABLES[name][2]).to_csv(
            paths.factor_csv(CSV[name]), index=False)
        print(f"{name}: {len(df)} months, {df['Date'].min():%Y-%m} .. {df['Date'].max():%Y-%m} -> {CSV[name]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

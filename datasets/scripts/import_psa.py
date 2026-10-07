"""
AgriPricePH — load official PSA OpenSTAT monthly rice stocks and palay farmgate prices (2015 onward).

    cd datasets && py -3.13 import_psa.py

- Backs up the database first (agriprice_database.db.backup-pre-psa-<timestamp>).
- Writes tables PSA_rice_stocks (Date, total, household, commercial, nfa — metric tons) and PSA_farmgate
  (Date, other_variety, fancy — PHP/kg), one row per month dated the month's first day, each row labelled
  Source = 'psa_openstat'. The old `rice_stock` / `farmgate_prices` tables are left untouched.
- Exports the same data to psa_rice_stocks_monthly.csv and psa_farmgate_palay_monthly.csv.
- model/data_pipeline.py uses the PSA tables when they exist (falling back to the old tables otherwise).

Why: the old tables stopped at Dec 2025 (the model carried Dec 2025 forward for 8 months) and differ from
PSA's current figures (e.g. Aug 2025 stocks 1.72M vs PSA 2.32M MT; farmgate fancy off by PHP 1.70 on average).
Safe to re-run: it rewrites both tables from PSA.
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
import psa_openstat as psa  # noqa: E402

DB_PATH = paths.DB_PATH
FROM_YEAR = 2015


def main() -> int:
    stocks = psa.fetch_rice_stocks(FROM_YEAR)
    farmgate = psa.fetch_palay_farmgate(FROM_YEAR)
    if stocks.empty or farmgate.empty:
        print("PSA returned no data — nothing changed.")
        return 1

    backup = paths.backup_path("pre-psa")
    shutil.copy2(DB_PATH, backup)
    print(f"Backup: {os.path.basename(backup)}")

    conn = sqlite3.connect(DB_PATH)
    try:
        psa.write_tables(conn, stocks, farmgate)
    finally:
        conn.close()
    for df, csv in ((stocks, "psa_rice_stocks_monthly.csv"), (farmgate, "psa_farmgate_palay_monthly.csv")):
        df.assign(Date=df["Date"].dt.strftime("%Y-%m-%d"), Source=psa.SOURCE).to_csv(paths.factor_csv(csv), index=False)
        print(f"{csv}: {len(df)} months, {df['Date'].min():%Y-%m} .. {df['Date'].max():%Y-%m}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

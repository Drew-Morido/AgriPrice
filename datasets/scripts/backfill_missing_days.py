"""
AgriPricePH — fill the days the scraper missed (DA rice bulletins and USD/PHP), then report what is left.

    cd datasets && py -3.13 backfill_missing_days.py              # rice: last 45 days, USD/PHP: since Jan 1
    cd datasets && py -3.13 backfill_missing_days.py --since 2026-05-01 --rice-days 90

- Backs up the database first (agriprice_database.db.backup-pre-backfill-<timestamp>).
- Rice: stores every DA Daily Price Index bulletin listed on da.gov.ph that has no DA row yet (a temporary
  estimate is replaced; official/verified rows are never touched). New values go through the same sanity
  guard as the daily scrape, so a suspicious one is held for review in Admin → Web Scraper.
- USD/PHP: fills each day without a rate from the dated currency archive (`scrap.RATE_HISTORY_URL`),
  rows tagged Source = currency_api_archive. A stored rate is never replaced.
- Fuel is weekly (DOE NCR) and already re-reads every DOE week on each scrape; this script only reports it.

The same catch-up also runs on every scrape cycle (`tools/scrap.py`, last 45 days), so gaps close by themselves.
Safe to re-run.
"""

from __future__ import annotations

import argparse
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths  # noqa: E402  (datasets/scripts/paths.py: every datasets/ location)
import shutil
import sqlite3
import sys
from datetime import date, datetime

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, paths.TOOLS_DIR)
import scrap  # noqa: E402

DB_PATH = paths.DB_PATH


def _gaps(table: str, start: date, end: date, where: str = "") -> list[date]:
    conn = sqlite3.connect(DB_PATH)
    try:
        dates = pd.to_datetime(pd.read_sql(f'SELECT Date FROM "{table}" {where}', conn)["Date"],
                               errors="coerce", format="mixed").dropna().dt.date
    finally:
        conn.close()
    have = set(dates)
    return [d.date() for d in pd.date_range(start, end) if d.date() not in have]


def _fmt(days: list[date]) -> str:
    if not days:
        return "none"
    runs: list[list[date]] = []
    for d in days:
        if runs and (d - runs[-1][1]).days == 1:
            runs[-1][1] = d
        else:
            runs.append([d, d])
    return ", ".join(f"{a}" if a == b else f"{a}..{b}" for a, b in runs)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--since", default=f"{date.today().year}-01-01", help="USD/PHP: fill from this day (YYYY-MM-DD)")
    ap.add_argument("--rice-days", type=int, default=scrap.CATCHUP_DAYS, help="rice: look back this many days")
    args = ap.parse_args()
    since = date.fromisoformat(args.since)
    today = date.today()

    backup = paths.backup_path("pre-backfill")
    shutil.copy2(DB_PATH, backup)
    print(f"Backup: {os.path.basename(backup)}")

    rice = scrap.backfill_rice_bulletins(days=args.rice_days)
    print(f"Rice: stored {len(rice)} DA bulletin(s): {', '.join(rice) or 'none'}")
    rates = scrap.backfill_exchange_rates(since=since)
    print(f"USD/PHP: filled {len(rates)} day(s)" + (f": {rates[0]} .. {rates[-1]}" if rates else ""))

    print("\nStill missing")
    print(f"  Rice (no DA row, {since}..{today}):",
          _fmt(_gaps("WS_rice_price", since, today, "WHERE COALESCE(Source,'') != 'estimated'")))
    print(f"  USD/PHP ({since}..{today}):", _fmt(_gaps("WS_currency", since, today, "WHERE USD_to_PHP IS NOT NULL")))
    conn = sqlite3.connect(DB_PATH)
    try:
        last_fuel = pd.to_datetime(pd.read_sql('SELECT Date FROM "WS_fuel"', conn)["Date"], format="mixed").max().date()
    finally:
        conn.close()
    print(f"  Fuel: weekly (DOE NCR); newest stored week starts {last_fuel}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

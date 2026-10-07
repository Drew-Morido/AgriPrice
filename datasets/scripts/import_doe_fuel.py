"""
AgriPricePH — load official DOE NCR weekly fuel prices into WS_fuel (every week DOE publishes).

    cd datasets && py -3.13 import_doe_fuel.py

- Backs up the database first (agriprice_database.db.backup-pre-doe-fuel-<timestamp>).
- Writes every DOE week to doe_ncr_fuel_weekly.csv (all weeks DOE lists, Dec 2024 onward) so the
  figures used can be checked against the PDFs.
- Replaces WS_fuel with one DOE row per week, Dec 2024 onward (DOE's current site starts there; its
  older site is offline). A product DOE printed as "#N/A" takes GasWatch PH's figure for the same week
  when available, listed in the "Filled" column.
- `model/data_pipeline.py` then ignores `fuel_history` (the 2015-2025 dataset) from the first DOE week on:
  that dataset runs PHP 10-20 above DOE's NCR common price through 2025, and two definitions on
  overlapping dates would make the feature zig-zag. See PAPER_CORRECTIONS.md, "Fuel source replaced with DOE".

Safe to re-run: it rewrites the same rows from the same PDFs (cached in tools/doe_fuel_cache).
"""

from __future__ import annotations

import csv
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths  # noqa: E402  (datasets/scripts/paths.py: every datasets/ location)
import shutil
import sqlite3
import sys
from datetime import datetime

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, paths.TOOLS_DIR)
import doe_fuel  # noqa: E402

DB_PATH = paths.DB_PATH
CSV_PATH = os.path.join(paths.DOE_DIR, "doe_ncr_fuel_weekly.csv")


def main() -> int:
    weeks = doe_fuel.fill_blanks_from_gaswatch(doe_fuel.fetch_doe_weeks(), doe_fuel.load_gaswatch())
    if not weeks:
        print("No DOE weeks could be read — nothing changed.")
        return 1

    with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["week_start", "week_label", "RON_95", "RON_91", "RON_97_100", "Diesel", "Diesel_Plus",
                    "Kerosene", "filled_from_gaswatch", "source_url"])
        for r in weeks:
            w.writerow([r["week_start"].isoformat(), r["week_label"], r.get("RON_95"), r.get("RON_91"),
                        r.get("RON_97"), r.get("Diesel"), r.get("Diesel_Plus"), r.get("Kerosene"),
                        ",".join(r.get("filled", [])), r["url"]])
    print(f"Wrote {len(weeks)} DOE weeks to {os.path.basename(CSV_PATH)}")

    backup = paths.backup_path("pre-doe-fuel")
    shutil.copy2(DB_PATH, backup)
    print(f"Backup: {os.path.basename(backup)}")

    conn = sqlite3.connect(DB_PATH)
    try:
        old = pd.read_sql('SELECT * FROM "WS_fuel"', conn)
        first = weeks[0]["week_start"]
        old_dates = pd.to_datetime(old["Date"], format="%m/%d/%Y", errors="coerce")
        keep = old[old_dates.dt.date < first].copy()
        for col in ("Source", "Filled"):
            if col not in keep.columns:
                keep[col] = None
        new = pd.DataFrame([doe_fuel.to_ws_fuel_row(r) for r in weeks])
        out = pd.concat([keep, new], ignore_index=True)
        out["_d"] = pd.to_datetime(out["Date"], format="%m/%d/%Y", errors="coerce")
        out = out.sort_values("_d").drop(columns="_d")
        out.to_sql("WS_fuel", conn, if_exists="replace", index=False)
        filled = sum(1 for r in weeks if r.get("filled"))
        print(f"WS_fuel: replaced {len(old) - len(keep)} row(s), wrote {len(new)} DOE week(s) "
              f"({filled} with GasWatch-filled blanks) "
              f"({new['Date'].iloc[0]} .. {new['Date'].iloc[-1]}); kept {len(keep)} earlier row(s).")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

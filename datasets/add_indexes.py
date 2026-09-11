"""
AgriPricePH — schema hardening: primary-key-equivalent indexes on the time-series tables.

Panel finding: `retail_prices` (4,018 rows) and `WS_rice_price` had no primary key and no index,
so every date lookup — which is what essentially every query does — was an O(n) full table scan,
while smaller lookup tables (`rice_price_bracket`, `tariff_schedule`) were indexed. It also meant
nothing structurally prevented duplicate-date rows from corrupting the merge in
`model/data_pipeline.py`.

Creates a UNIQUE index on Date where the column is already unique (which enforces the constraint
going forward), and a plain index where it is not, reporting the duplicates rather than silently
dropping rows. Idempotent.

Run:  py -3.13 datasets/add_indexes.py
"""
from __future__ import annotations

import os
import sqlite3

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "agriprice_database.db")

# table -> date column
DATE_TABLES = {
    "retail_prices": "Date",
    "WS_rice_price": "Date",
    "fuel_history": "Date",
    "WS_fuel": "Date",
    "usd_php_rates": "Date",
    "WS_currency": "Date",
    "farmgate_prices": "Date",
    "rice_stock": "Date",
    "weather_data": "Date",
}


def add_indexes(db_path: str = DB_PATH, verbose: bool = True) -> dict:
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    existing = {r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    made = dups = 0

    for table, col in DATE_TABLES.items():
        if table not in existing:
            continue
        cols = [r[1] for r in cur.execute(f'PRAGMA table_info("{table}")')]
        if col not in cols:
            continue
        total = cur.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        distinct = cur.execute(f'SELECT COUNT(DISTINCT "{col}") FROM "{table}"').fetchone()[0]
        name = f"ix_{table.lower()}_date"
        unique = "UNIQUE " if total == distinct else ""
        if total != distinct:
            dups += 1
            if verbose:
                print(f"  [warn] {table}: {total - distinct} duplicate {col} value(s) — "
                      f"creating non-unique index; de-duplicate before enforcing UNIQUE")
        try:
            cur.execute(f'CREATE {unique}INDEX IF NOT EXISTS "{name}" ON "{table}" ("{col}")')
            made += 1
            if verbose:
                print(f"  [ok] {name} ({'UNIQUE' if unique else 'non-unique'}) on {table} "
                      f"({total} rows)")
        except sqlite3.OperationalError as exc:
            if verbose:
                print(f"  [skip] {table}: {exc}")

    # Write-Ahead Logging: the API runs Flask with threaded=True against SQLite, so concurrent
    # readers would otherwise block on a writer (scraper / training run).
    mode = cur.execute("PRAGMA journal_mode=WAL").fetchone()[0]
    cur.execute("PRAGMA synchronous=NORMAL")
    conn.commit()
    conn.close()
    if verbose:
        print(f"  [ok] journal_mode={mode}")
        print(f"[done] {made} index(es) ensured, {dups} table(s) with duplicate dates")
    return {"indexes": made, "dup_tables": dups, "journal_mode": mode}


if __name__ == "__main__":
    add_indexes()

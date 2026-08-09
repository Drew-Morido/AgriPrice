"""
AgriPricePH — rice catalog schema (DTI categories/brands, markets, price brackets, taxes).

Additive and non-breaking: the existing `retail_prices` / `WS_rice_price` time series that the
LSTM uses are untouched. This adds a normalized catalog layer used for display/reporting:

    dti_category  1─┐
                    ├─< rice_brand
                    └─< rice_price_bracket >── market
    tax_component (independent dimension, applied at query/report time)

The 8 existing categories are seeded and mapped to the model's canonical keys
(locWellMilled … impSpecial). Brands, brackets, and tax rows are intentionally left EMPTY —
they require official DTI / BOC / BIR data and must NOT be invented. The app degrades
gracefully while they are empty.

Run:  py -3.13 datasets/catalog_schema.py           # create + seed (idempotent)
      py -3.13 datasets/catalog_schema.py --status  # show row counts
"""

from __future__ import annotations

import argparse
import os
import sqlite3

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _db_path() -> str:
    env = os.environ.get("AGRIPRICE_DB_PATH")
    if env and os.path.isfile(env):
        return env
    datasets_db = os.path.join(PROJECT_ROOT, "datasets", "agriprice_database.db")
    api_db = os.path.join(PROJECT_ROOT, "api", "agriprice_database.db")
    return datasets_db if os.path.isfile(datasets_db) else (api_db if os.path.isfile(api_db) else datasets_db)


# The 8 existing categories mapped to model canonical keys. Names are the DTI-facing labels;
# canonical_key ties each to the trained model / retail_prices column. [VERIFY names with DTI.]
SEED_CATEGORIES = [
    ("Local Special",        "Local",    "locSpecial"),
    ("Local Premium",        "Local",    "locPremium"),
    ("Local Well-Milled",    "Local",    "locWellMilled"),
    ("Local Regular-Milled", "Local",    "locRegular"),
    ("Imported Special",     "Imported", "impSpecial"),
    ("Imported Premium",     "Imported", "impPremium"),
    ("Imported Well-Milled", "Imported", "impWellMilled"),
    ("Imported Regular-Milled", "Imported", "impRegular"),
]

DDL = """
CREATE TABLE IF NOT EXISTS dti_category (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE,
    segment       TEXT NOT NULL CHECK (segment IN ('Local','Imported')),
    canonical_key TEXT NOT NULL UNIQUE,
    active        INTEGER NOT NULL DEFAULT 1,
    dti_verified  INTEGER NOT NULL DEFAULT 0,   -- 0 until confirmed against DTI's official list
    notes         TEXT
);

CREATE TABLE IF NOT EXISTS rice_brand (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES dti_category(id),
    brand_name  TEXT NOT NULL,
    is_verified INTEGER NOT NULL DEFAULT 0,      -- [VERIFY: DTI]
    source      TEXT,
    notes       TEXT,
    UNIQUE (category_id, brand_name)
);

CREATE TABLE IF NOT EXISTS market (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    province    TEXT NOT NULL,
    market_name TEXT,
    region      TEXT,
    UNIQUE (province, market_name)
);

CREATE TABLE IF NOT EXISTS rice_price_bracket (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id    INTEGER NOT NULL REFERENCES dti_category(id),
    brand_id       INTEGER REFERENCES rice_brand(id),
    market_id      INTEGER REFERENCES market(id),
    effective_date TEXT NOT NULL,                -- YYYY-MM-DD
    price_min      REAL NOT NULL,
    price_max      REAL NOT NULL,
    source         TEXT,
    CHECK (price_min <= price_max)
);
CREATE INDEX IF NOT EXISTS ix_bracket_cat_date ON rice_price_bracket(category_id, effective_date);

CREATE TABLE IF NOT EXISTS tax_component (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('tariff','VAT','import_fee','other')),
    rate_pct       REAL,                         -- percent (e.g., 12.0) OR
    flat_amount    REAL,                         -- flat PHP/kg; exactly one of rate_pct/flat_amount
    applies_to     TEXT NOT NULL DEFAULT 'imported' CHECK (applies_to IN ('imported','all')),
    effective_date TEXT,
    legal_basis    TEXT,                         -- e.g., RA 11203 / EO 62 s.2024 / NIRC  [VERIFY]
    source         TEXT,
    active         INTEGER NOT NULL DEFAULT 1,
    verified       INTEGER NOT NULL DEFAULT 0    -- 0 until confirmed with BOC/BIR/DTI
);
"""


def create_catalog_tables(conn: sqlite3.Connection) -> None:
    conn.executescript(DDL)
    conn.commit()


def seed_categories(conn: sqlite3.Connection) -> int:
    cur = conn.cursor()
    added = 0
    for name, segment, key in SEED_CATEGORIES:
        cur.execute("SELECT 1 FROM dti_category WHERE canonical_key = ?", (key,))
        if cur.fetchone():
            continue
        cur.execute(
            "INSERT INTO dti_category(name, segment, canonical_key, active, dti_verified, notes) "
            "VALUES (?,?,?,1,0,?)",
            (name, segment, key, "Seeded from existing 8 categories; confirm label with DTI"),
        )
        added += 1
    conn.commit()
    return added


def status(conn: sqlite3.Connection) -> dict:
    cur = conn.cursor()
    out = {}
    for t in ("dti_category", "rice_brand", "market", "rice_price_bracket", "tax_component"):
        try:
            cur.execute(f"SELECT COUNT(*) FROM {t}")
            out[t] = cur.fetchone()[0]
        except sqlite3.OperationalError:
            out[t] = "missing"
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Create/seed the AgriPricePH rice catalog schema")
    ap.add_argument("--status", action="store_true", help="show table row counts only")
    args = ap.parse_args()

    db = _db_path()
    if not os.path.exists(db):
        print(f"[ERROR] database not found at {db}. Run datasets/script.py first.")
        return 1
    conn = sqlite3.connect(db)
    try:
        if args.status:
            print(f"DB: {db}")
            for t, c in status(conn).items():
                print(f"  {t}: {c}")
            return 0
        create_catalog_tables(conn)
        added = seed_categories(conn)
        print(f"[OK] catalog schema ready in {db}")
        print(f"[OK] seeded {added} new categories (8 total expected)")
        print("[INFO] brands / brackets / taxes are EMPTY — populate from official DTI/BOC data.")
        for t, c in status(conn).items():
            print(f"  {t}: {c}")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())

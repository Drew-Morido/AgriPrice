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
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id    INTEGER NOT NULL REFERENCES dti_category(id),
    brand_name     TEXT NOT NULL,
    package        TEXT,                          -- actual product/SKU name, e.g. "... Rice 5kg"
    location       TEXT,                          -- NCR city / store, or "NCR"
    source         TEXT,                          -- label, e.g. "Official Brand Website" — required
    source_url     TEXT,                          -- clickable citation
    last_verified  TEXT,                          -- YYYY-MM-DD
    classification_note TEXT,                     -- basis for the 8-category assignment
    -- verification_status replaces the old boolean is_verified (Phase 3): a brand starts
    -- 'unverified' and is promoted by an admin who has actually checked it, either against the
    -- field ('field_verified') or against an official DTI list ('dti_verified').
    verification_status TEXT NOT NULL DEFAULT 'unverified'
                   CHECK (verification_status IN ('unverified','field_verified','dti_verified')),
    verified_by    TEXT,                          -- admin client key / identity who set the status
    verified_at    TEXT,                          -- YYYY-MM-DD HH:MM:SS
    active         INTEGER NOT NULL DEFAULT 1,    -- soft-delete: 0 = deactivated, kept for history
    notes          TEXT,
    UNIQUE (category_id, brand_name, package)
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

-- Rice import tariff is NOT fixed: under EO 105 s.2025 + IAGRTA Circular 2025-001 it is a
-- quarterly, price-indexed MFN rate bounded to 15%-35% (Vietnam 5% broken rice, FAO, vs a
-- March-2025 baseline). Each confirmed quarter is one dated row here; consumer_price() picks
-- the row whose [effective_start, effective_end] covers the query date. Never overwrite a past
-- quarter — append a new row. If today falls outside every row, the app shows the last confirmed
-- rate flagged as stale (it does NOT silently roll a past rate forward or invent a new one).
CREATE TABLE IF NOT EXISTS tariff_schedule (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    rate_pct             REAL NOT NULL,           -- MFN duty %, in-quota = out-quota
    effective_start      TEXT NOT NULL,           -- YYYY-MM-DD (first day the rate applies)
    effective_end        TEXT,                    -- YYYY-MM-DD; NULL = open-ended (avoid for quarters)
    quarter_label        TEXT,                    -- e.g. 'Q1 2026'
    legal_basis          TEXT,                    -- EO / IAGRTA Circular / BOC CMO number
    da_certification_url TEXT,                    -- official DA certification / BOC CMO link
    source               TEXT,
    verified             INTEGER NOT NULL DEFAULT 0,
    approved_by          TEXT,                    -- admin who confirmed the rate
    approved_at          TEXT,                    -- YYYY-MM-DD HH:MM:SS
    created_at           TEXT DEFAULT (datetime('now')),
    active               INTEGER NOT NULL DEFAULT 1,
    entry_type           TEXT NOT NULL DEFAULT 'OFFICIAL',  -- OFFICIAL (source-based) | ADMIN (admin-entered)
    notes                TEXT
);
CREATE INDEX IF NOT EXISTS ix_tariff_start ON tariff_schedule(effective_start);

-- Append-only audit trail: who changed the tariff, when, and why.
CREATE TABLE IF NOT EXISTS tariff_audit (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    action          TEXT NOT NULL,               -- add / approve / deactivate / seed
    rate_pct        REAL,
    effective_start TEXT,
    effective_end   TEXT,
    quarter_label   TEXT,
    actor           TEXT,                        -- admin client key / identity
    detail          TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
);

-- Small key/value config for the FAO indicative-rate helper (baseline reference price, etc.).
CREATE TABLE IF NOT EXISTS tariff_config (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    source     TEXT,
    updated_at TEXT
);

-- Rice Brand module Phase 2 — variance weight ("patong"): an observed retail premium/discount
-- for ONE brand vs. its category's plain forecast price. This is display-layer only: it is never
-- fed back into the LSTM (model/ is untouched) and never invented — a brand keeps NULL/no row
-- here (falls back to the plain category price) until someone actually canvasses it.
-- One current weight per brand; brand_weight_audit below is the append-only history of changes.
CREATE TABLE IF NOT EXISTS brand_price_adjustment (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_id          INTEGER NOT NULL UNIQUE REFERENCES rice_brand(id),
    weight_pct        REAL NOT NULL,          -- % vs. category base price; e.g. 8.5 = +8.5%
    sample_date       TEXT,                   -- YYYY-MM-DD the % was observed/surveyed
    sample_locations  TEXT,                   -- where canvassed, e.g. "NCR - Quiapo, Divisoria"
    sample_n          INTEGER,                -- number of price points sampled
    source_notes      TEXT,                   -- free-text methodology / citation
    entry_type        TEXT NOT NULL DEFAULT 'ADMIN' CHECK (entry_type IN ('ADMIN','OFFICIAL')),
    updated_by        TEXT,
    updated_at        TEXT DEFAULT (datetime('now'))
);

-- Append-only audit trail: who changed a brand's weight, when, and to what — mirrors tariff_audit.
CREATE TABLE IF NOT EXISTS brand_weight_audit (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_id        INTEGER NOT NULL,
    action          TEXT NOT NULL,           -- 'set' / 'clear'
    weight_pct      REAL,
    sample_date     TEXT,
    sample_locations TEXT,
    sample_n        INTEGER,
    actor           TEXT,                    -- admin client key / identity
    detail          TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_brand_weight_audit_brand ON brand_weight_audit(brand_id);

-- Rice Brand module Phase 3 — full CRUD + governance. Append-only audit trail for the brand
-- catalog record itself (add / update / verify / deactivate / reactivate) — mirrors tariff_audit.
CREATE TABLE IF NOT EXISTS brand_audit (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_id        INTEGER NOT NULL,
    action          TEXT NOT NULL,           -- add / update / verify / deactivate / reactivate
    actor           TEXT,                    -- admin client key / identity
    detail          TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_brand_audit_brand ON brand_audit(brand_id);
"""


def _ensure_brand_schema(conn: sqlite3.Connection) -> None:
    """Migrate an older rice_brand table up to the current schema, column by column (idempotent —
    safe to call on every startup). Two generations of migration live here:
      - Phase 1/2: package/location/source_url/last_verified/classification_note (TEXT, nullable).
      - Phase 3: is_verified (bool) -> verification_status/verified_by/verified_at + active
        (soft-delete). Every existing row is migrated to verification_status='field_verified' —
        it was already carrying real source/location/URL data, i.e. someone had looked it up, so
        that's the honest tier (not 'dti_verified', which is reserved for an official DTI list)."""
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='rice_brand'")
    if not cur.fetchone():
        return
    cols = [r[1] for r in cur.execute("PRAGMA table_info(rice_brand)")]
    if not cols:
        return

    n = cur.execute("SELECT COUNT(*) FROM rice_brand").fetchone()[0]
    if n == 0 and "verification_status" not in cols:
        cur.execute("DROP TABLE rice_brand")  # empty -> safe to recreate with the current schema
        conn.commit()
        return

    if "package" not in cols:
        for c in ("package", "location", "source_url", "last_verified", "classification_note"):
            if c not in cols:
                cur.execute(f"ALTER TABLE rice_brand ADD COLUMN {c} TEXT")
        cols = [r[1] for r in cur.execute("PRAGMA table_info(rice_brand)")]

    if "verification_status" not in cols:
        cur.execute("ALTER TABLE rice_brand ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unverified'")
        cur.execute("ALTER TABLE rice_brand ADD COLUMN verified_by TEXT")
        cur.execute("ALTER TABLE rice_brand ADD COLUMN verified_at TEXT")
        cur.execute("ALTER TABLE rice_brand ADD COLUMN active INTEGER NOT NULL DEFAULT 1")
        if "is_verified" in cols:
            # Every pre-Phase-3 row already carried real source/location data — migrate all of
            # them to 'field_verified' (never invent a stronger 'dti_verified' claim here).
            cur.execute("UPDATE rice_brand SET verification_status='field_verified', "
                        "verified_at=COALESCE(last_verified, verified_at)")
            try:
                cur.execute("ALTER TABLE rice_brand DROP COLUMN is_verified")
            except sqlite3.OperationalError:
                pass  # older SQLite (<3.35) can't DROP COLUMN — the stale column is just unused
        else:
            cur.execute("UPDATE rice_brand SET verification_status='field_verified'")
    conn.commit()


def _ensure_tariff_schema(conn: sqlite3.Connection) -> None:
    """Add tariff_schedule.entry_type to an existing DB (idempotent). Existing rows default to
    OFFICIAL (source-based); admin-entered rows are marked ADMIN at insert time."""
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='tariff_schedule'")
    if not cur.fetchone():
        return
    cols = [r[1] for r in cur.execute("PRAGMA table_info(tariff_schedule)")]
    if "entry_type" not in cols:
        cur.execute("ALTER TABLE tariff_schedule ADD COLUMN entry_type TEXT NOT NULL DEFAULT 'OFFICIAL'")
    conn.commit()


def create_catalog_tables(conn: sqlite3.Connection) -> None:
    _ensure_brand_schema(conn)
    conn.executescript(DDL)
    _ensure_tariff_schema(conn)
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
    for t in ("dti_category", "rice_brand", "market", "rice_price_bracket", "tax_component",
              "tariff_schedule", "tariff_audit", "tariff_config",
              "brand_price_adjustment", "brand_weight_audit", "brand_audit"):
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

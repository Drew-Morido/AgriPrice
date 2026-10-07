"""
AgriPricePH — every location inside datasets/, in one place (layout since 2026-10-07; see datasets/README.md).

    datasets/
      agriprice_database.db      the live database (the app, the model and the scraper read and write it)
      1_factor_csv/              one final CSV per factor, 2015 to the latest day (export_factors.py)
      2_backup_database/
        by_factor/               one SQLite copy per factor (export_factors.py)
        full_snapshots/          a copy of the whole database taken before each change (backup_path())
      3_source_files/            everything downloaded or received from DA, PSA, DOE, the World Bank, ...
      scripts/                   the import / rebuild / export scripts (this folder)

Scripts import from here instead of building paths from their own location, so moving a folder means editing
one file.
"""

from __future__ import annotations

import os
from datetime import datetime

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
DATASETS_DIR = os.path.dirname(SCRIPTS_DIR)
PROJECT_ROOT = os.path.dirname(DATASETS_DIR)
TOOLS_DIR = os.path.join(PROJECT_ROOT, "tools")
API_DIR = os.path.join(PROJECT_ROOT, "api")

DB_PATH = os.path.join(DATASETS_DIR, "agriprice_database.db")

FACTOR_CSV_DIR = os.path.join(DATASETS_DIR, "1_factor_csv")
BACKUP_DIR = os.path.join(DATASETS_DIR, "2_backup_database")
BY_FACTOR_DIR = os.path.join(BACKUP_DIR, "by_factor")
SNAPSHOT_DIR = os.path.join(BACKUP_DIR, "full_snapshots")
SOURCES_DIR = os.path.join(DATASETS_DIR, "3_source_files")

DA_DIR = os.path.join(SOURCES_DIR, "DA-AMAS")
DA_BULLETIN_PDF_DIR = os.path.join(DA_DIR, "daily_bulletins_pdf")        # fetch_da_bulletins.py cache
DA_DPI_PDF_DIR = os.path.join(DA_DIR, "daily_price_index_pdf")           # repair_ws_rice_from_bulletins.py cache
DA_SCRAPER_PDF_DIR = os.path.join(DA_DIR, "scraper_downloads")           # tools/scrap.py, each bulletin it reads
DA_WEEKLY_DIR = os.path.join(DA_DIR, "weekly_prevailing")
DA_PARSED_DIR = os.path.join(DA_DIR, "parsed")
PSA_DIR = os.path.join(SOURCES_DIR, "PSA")
PSA_DOWNLOADS_DIR = os.path.join(PSA_DIR, "openstat_downloads")
PSA_API_DIR = os.path.join(PSA_DIR, "api_exports")
WORLD_BANK_DIR = os.path.join(SOURCES_DIR, "World_Bank")
DOE_DIR = os.path.join(SOURCES_DIR, "DOE")
DOE_PDF_DIR = os.path.join(DOE_DIR, "weekly_pdf")                        # tools/doe_fuel.py cache
FX_DIR = os.path.join(SOURCES_DIR, "Exchange_Rate")
LEGACY_DIR = os.path.join(SOURCES_DIR, "legacy_inputs")
BRAND_DIR = os.path.join(SOURCES_DIR, "brand_survey")


def da_parsed(name: str) -> str:
    return os.path.join(DA_PARSED_DIR, name)


def factor_csv(name: str) -> str:
    return os.path.join(FACTOR_CSV_DIR, name)


def backup_path(tag: str, stamp: str | None = None) -> str:
    """Where a full database copy taken before a change goes: full_snapshots/agriprice_database.db.backup-<tag>-<stamp>."""
    os.makedirs(SNAPSHOT_DIR, exist_ok=True)
    stamp = stamp or datetime.now().strftime("%Y%m%d-%H%M%S")
    return os.path.join(SNAPSHOT_DIR, f"agriprice_database.db.backup-{tag}-{stamp}")

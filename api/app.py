"""
app.py  —  AgriPricePH v3
==========================
Unified Flask API server + scraper console.
Pinagsama na ang dating app.py (dashboard API) at scraper_console.py.

Dalawang paraan ng paggamit:

  1. API Server mode (default — para sa dashboard + web-scraper.html):
       python app.py                          # Flask sa port 5000
       python app.py --serve --port 8080      # custom port
       python app.py --serve --host 0.0.0.0   # bukas sa network

  2. Console/CLI mode (walang Flask):
       python app.py --once                   # single scrape run, then exit
       python app.py --loop                   # loop every 24h
       python app.py --loop --interval 3600   # custom interval (seconds)

Endpoints:
  GET  /api/historical-data   — merged rice/fuel/exchange data para sa charts
  GET  /api/scrape-status     — JSON: logs, stats, CSV previews
  POST /api/run-scraper       — trigger manual scrape (non-blocking)
  GET  /api/stream-scrape     — SSE stream ng live logs habang nag-sscrape
  GET  /api/health            — simple health check
  POST /api/save-export       — save CSV export to disk
"""

import argparse
import json
import logging
import math
import os
import re
import queue
import sqlite3
import sys
import threading
import time
from collections import deque
from datetime import date, datetime, timedelta



import pandas as pd
from flask import Flask, Response, abort, jsonify, redirect, request, send_from_directory
from flask_cors import CORS
from werkzeug.utils import secure_filename

# ─── Import scraper functions (lazy-safe; errors surface at scrape time) ──────
# These are imported at module level so CLI --once/--loop modes work without Flask.

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)
TOOLS_DIR = os.path.join(PROJECT_ROOT, 'tools')
_DATASETS_DB_EARLY = os.path.join(PROJECT_ROOT, "datasets", "agriprice_database.db")
_API_DB_EARLY = os.path.join(BASE_DIR, "agriprice_database.db")
os.environ.setdefault(
    "AGRIPRICE_DB_PATH",
    _DATASETS_DB_EARLY if os.path.exists(_DATASETS_DB_EARLY) else _API_DB_EARLY,
)

# Load .env from the project root (not cwd — run_backend.bat cd's into api/
# before running, so a bare load_dotenv() would look in api/.env and miss a
# root-level .env). Optional: degrades silently if python-dotenv isn't
# installed yet; AGRIPRICE_GMAIL_APP_PASSWORD can still be set another way.
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(PROJECT_ROOT, ".env"))
except ImportError:
    pass

if TOOLS_DIR not in sys.path:
    sys.path.insert(0, TOOLS_DIR)

try:
    from scrap import (
        fetch_core_inflation,
        fetch_exchange_rates,
        fetch_fuel_prices,
        fetch_psa_monthly,
        fetch_rice_prices,
        fetch_tariff_rate,
        fetch_world_rice,
    )
    _SCRAPER_AVAILABLE = True
except ImportError as _scraper_import_err:
    _SCRAPER_AVAILABLE = False
    _SCRAPER_IMPORT_ERROR = str(_scraper_import_err)

    def fetch_rice_prices():  # type: ignore
        raise RuntimeError(f"Scraper unavailable: {_SCRAPER_IMPORT_ERROR}")

    def fetch_fuel_prices():  # type: ignore
        raise RuntimeError(f"Scraper unavailable: {_SCRAPER_IMPORT_ERROR}")

    def fetch_exchange_rates():  # type: ignore
        raise RuntimeError(f"Scraper unavailable: {_SCRAPER_IMPORT_ERROR}")

    def fetch_tariff_rate():  # type: ignore
        raise RuntimeError(f"Scraper unavailable: {_SCRAPER_IMPORT_ERROR}")

    def fetch_psa_monthly():  # type: ignore
        raise RuntimeError(f"Scraper unavailable: {_SCRAPER_IMPORT_ERROR}")

    def fetch_core_inflation():  # type: ignore
        raise RuntimeError(f"Scraper unavailable: {_SCRAPER_IMPORT_ERROR}")

    def fetch_world_rice():  # type: ignore
        raise RuntimeError(f"Scraper unavailable: {_SCRAPER_IMPORT_ERROR}")

# ─── Paths ────────────────────────────────────────────────────────────────────
BASE_DIR     = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)

# Historical SQLite DB (used by /api/historical-data and ML training)
_DATASETS_DB = os.path.join(PROJECT_ROOT, "datasets", "agriprice_database.db")
_API_DB = os.path.join(BASE_DIR, "agriprice_database.db")
DB_PATH = _DATASETS_DB if os.path.exists(_DATASETS_DB) else _API_DB

MODEL_DIR = os.path.join(PROJECT_ROOT, "model")
DATASETS_DIR = os.path.join(PROJECT_ROOT, "datasets")
# Import / rebuild / export scripts live in datasets/scripts/ (folder layout: datasets/README.md).
DATASET_SCRIPTS_DIR = os.path.join(DATASETS_DIR, "scripts")
FACTOR_CSV_DIR = os.path.join(DATASETS_DIR, "1_factor_csv")
if MODEL_DIR not in sys.path:
    sys.path.insert(0, MODEL_DIR)
if DATASET_SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, DATASET_SCRIPTS_DIR)

# Raw scraper CSVs (used by /api/scrape-status previews)
PRICE_CSV = os.path.join(BASE_DIR, "..", "tools", "scrapped price",  "agriprice_database.csv")
FUEL_CSV  = os.path.join(BASE_DIR, "..", "tools", "scrapped fuel",   "fuel_database.csv")
RATE_CSV  = os.path.join(BASE_DIR, "..", "tools", "scrapped rate",   "exchange_rate_database.csv")

DEFAULT_INTERVAL = 24 * 60 * 60   # 24 hours in seconds
PREVIEW_ROWS     = 10
MAX_LOG_LINES    = 200

# ─── Shared scraper state ─────────────────────────────────────────────────────
_LOG_BUFFER: deque       = deque(maxlen=MAX_LOG_LINES)
_LOG_LOCK                = threading.Lock()

_SSE_QUEUES: list[queue.Queue] = []
_SSE_LOCK                      = threading.Lock()

_scrape_running  = False
_scrape_lock     = threading.Lock()
_scrape_started_at: datetime | None = None
_last_scrape_ts: datetime | None = None
_last_scrape_ok: bool | None     = None
_last_source_ts: dict[str, datetime | None] = {"da": None, "doe": None, "api": None, "tc": None, "psa": None,
                                               "cpi": None, "wb": None}
SCRAPE_STALE_SEC = 300  # force-release stuck "running" after 5 minutes

SOURCE_META = {
    "da": {
        "ws_table": "WS_rice_price",
        "hist_sql": 'SELECT Date FROM retail_prices',
        "ws_sql":   'SELECT Date FROM "WS_rice_price"',
        "csv":      PRICE_CSV,
        "fetch":    "rice",
    },
    "doe": {
        "ws_table": "WS_fuel",
        "hist_sql": "SELECT Date FROM fuel_history",
        "ws_sql":   'SELECT Date FROM "WS_fuel"',
        "csv":      FUEL_CSV,
        "fetch":    "fuel",
    },
    "api": {
        "ws_table": "WS_currency",
        "hist_sql": 'SELECT Date FROM usd_php_rates',
        "ws_sql":   'SELECT Date FROM "WS_currency"',
        "csv":      RATE_CSV,
        "fetch":    "rates",
    },
    # No daily WS_* table or CSV mirror — tariff_schedule is quarterly, not a per-day row count,
    # so "csv" only exists here to satisfy _infer_source_fetch_time's fallback signature; it never
    # resolves to a real file, and _last_source_ts["tc"] (set on every successful scrape run) is
    # what actually drives "Last Fetch" for this source.
    "tc": {
        "ws_table": None,
        "hist_sql": None,
        "ws_sql":   None,
        "csv":      os.path.join(BASE_DIR, "..", "tools", "_tariff_no_csv_marker"),
        "fetch":    "tariff",
    },
    # PSA OpenSTAT monthly series (PSA_rice_stocks / PSA_farmgate). "Last Fetch" comes from
    # _last_source_ts["psa"] or PSA_meta.fetched_at (see _build_psa_source), not from a CSV.
    "psa": {
        "ws_table": "PSA_rice_stocks",
        "hist_sql": None,
        "ws_sql":   'SELECT Date FROM "PSA_rice_stocks"',
        "csv":      os.path.join(FACTOR_CSV_DIR, "psa_rice_stocks_monthly.csv"),
        "fetch":    "psa",
    },
    # Monthly economic factors (model inputs since 2026-10-07, tools/macro_factors.py). "Last Fetch" comes from
    # _last_source_ts or MACRO_meta.fetched_at (see _build_macro_source).
    "cpi": {
        "ws_table": "MACRO_core_inflation",
        "hist_sql": None,
        "ws_sql":   'SELECT Date FROM "MACRO_core_inflation"',
        "csv":      os.path.join(FACTOR_CSV_DIR, "psa_core_inflation_monthly.csv"),
        "fetch":    "cpi",
    },
    "wb": {
        "ws_table": "MACRO_world_rice",
        "hist_sql": None,
        "ws_sql":   'SELECT Date FROM "MACRO_world_rice"',
        "csv":      os.path.join(FACTOR_CSV_DIR, "worldbank_rice_monthly.csv"),
        "fetch":    "wb",
    },
}


# ─── Logging: buffer handler (captures Python logs → in-memory + SSE) ─────────
class BufferHandler(logging.Handler):
    """Pushes every log record into _LOG_BUFFER and broadcasts to SSE subscribers."""

    _LEVEL_MAP = {
        "INFO":     "INFO",
        "WARNING":  "WARN",
        "ERROR":    "ERROR",
        "CRITICAL": "ERROR",
        "DEBUG":    "INFO",
    }

    @staticmethod
    def _source_from(name: str) -> str:
        n = (name or "").lower()
        if "scrap" in n:
            return "SCRAPER"
        if "train" in n:
            return "TRAINING"
        if "alert" in n:
            return "ALERTS"
        return "SYSTEM"

    def emit(self, record: logging.LogRecord) -> None:
        # Skip raw Werkzeug HTTP access lines — they are framework request noise (and carry ANSI
        # codes), not the semantic app events System Logs / the scraper activity view want to show.
        if record.name == "werkzeug":
            return
        entry = {
            "time":   datetime.now().strftime("%I:%M:%S %p"),
            "level":  self._LEVEL_MAP.get(record.levelname, "INFO"),
            "source": self._source_from(record.name),
            "msg":    self.format(record),
        }
        with _LOG_LOCK:
            _LOG_BUFFER.append(entry)
        _broadcast_sse(entry)


def _broadcast_sse(entry: dict) -> None:
    """Fan-out a log entry to all active SSE subscriber queues."""
    data = json.dumps(entry)
    with _SSE_LOCK:
        dead = []
        for q in _SSE_QUEUES:
            try:
                q.put_nowait(data)
            except queue.Full:
                dead.append(q)
        for q in dead:
            _SSE_QUEUES.remove(q)


def _setup_logging() -> None:
    """Attach handlers once and prevent duplicate log propagation."""
    root = logging.getLogger()
    root.setLevel(logging.INFO)

    if not any(isinstance(h, BufferHandler) for h in root.handlers):
        buf_handler = BufferHandler()
        buf_handler.setFormatter(logging.Formatter("%(message)s"))
        root.addHandler(buf_handler)

    if not any(isinstance(h, logging.StreamHandler) and h.stream is sys.stdout for h in root.handlers):
        con_handler = logging.StreamHandler(sys.stdout)
        con_handler.setFormatter(
            logging.Formatter("%(asctime)s | %(levelname)s | %(message)s", "%I:%M:%S %p")
        )
        root.addHandler(con_handler)

    # Let scraper logs flow to root only (single output line per event).
    scraper_log = logging.getLogger("agriprice_scraper")
    scraper_log.setLevel(logging.INFO)
    scraper_log.handlers.clear()
    scraper_log.propagate = True


def _add_log(level: str, msg: str, source: str = "SYSTEM") -> None:
    """Manually push a log entry (for events that originate outside the logger)."""
    entry = {
        "time":   datetime.now().strftime("%I:%M:%S %p"),
        "level":  level,
        "source": source,
        "msg":    msg,
    }
    with _LOG_LOCK:
        _LOG_BUFFER.append(entry)
    _broadcast_sse(entry)


# ─── Scrape runner ────────────────────────────────────────────────────────────
def _release_scrape_lock() -> None:
    global _scrape_running, _scrape_started_at
    with _scrape_lock:
        _scrape_running = False
        _scrape_started_at = None


def _maybe_clear_stale_scrape() -> None:
    """Recover if a scrape thread died without clearing the running flag."""
    global _scrape_running, _scrape_started_at
    if not _scrape_running or not _scrape_started_at:
        return
    age = (datetime.now() - _scrape_started_at).total_seconds()
    if age > SCRAPE_STALE_SEC:
        logging.getLogger("agriprice_scraper").warning(
            "Scrape lock stale (%ss) — releasing.", int(age)
        )
        _release_scrape_lock()


def _refresh_forecast_async() -> None:
    """Rebuild the published forecast in the background after new data, so no visitor waits for it and the
    day's forecast is written to the forward-evaluation log. A no-op rebuild when the model's inputs did not
    change (predict's cache key covers the last verified day and a fingerprint of the latest inputs)."""
    logger = logging.getLogger("agriprice_scraper")

    def _run():
        try:
            from predict import warm_payload
            if warm_payload():
                logger.info("Forecast is up to date with the latest verified data.")
        except Exception as exc:
            logger.warning("Forecast refresh after scrape skipped: %s", exc)
    threading.Thread(target=_run, daemon=True).start()


def _do_scrape(skip=()) -> bool:
    """
    One full sync: DA rice → DOE fuel → exchange rates → tariff → PSA monthly (stocks, farmgate).
    Rice/fuel/rates/PSA write straight to their tables; tariff only ever stages an inactive candidate for
    admin review (see fetch_tariff_rate). `skip`: source ids switched off in Admin → Settings (da, doe, api,
    psa) — reported as SKIPPED, not FAILED. Logs each step (SSE stream and /api/scrape-status).
    Thread-safe: skips if a scrape is already in progress.
    """
    global _scrape_running, _last_scrape_ts, _last_scrape_ok, _scrape_started_at

    with _scrape_lock:
        if _scrape_running:
            logging.getLogger("agriprice_scraper").warning(
                "Scrape already running — skipping."
            )
            return False
        _scrape_running = True
        _scrape_started_at = datetime.now()

    logger = logging.getLogger("agriprice_scraper")
    # (result key, source id, label, fetcher, start message, message when it returns False)
    steps = [
        ("rice", "da", "Rice", fetch_rice_prices,
         "DA-AMAS IS SCRAPING NOW // https://www.da.gov.ph/price-monitoring/",
         "DA-AMAS rice scrape failed — check logs above."),
        ("fuel", "doe", "Fuel", fetch_fuel_prices,
         "DATA FUEL IS SCRAPING NOW // DOE NCR weekly pump prices "
         "(https://doe.gov.ph/data-and-prices/liquid-fuels/retail-pump-prices/ncr-pump-prices)",
         "DOE fuel fetch failed (GasWatch PH fallback too) — kept the stored weeks."),
        ("rates", "api", "Rates", fetch_exchange_rates,
         "RATE EXCHANGE IS SCRAPING NOW // https://open.er-api.com/v6/latest/USD",
         "ALREADY SCRAPPED OR FAILED TO FETCH EXCHANGE RATES"),
        # Tariff only ever STAGES a candidate; the rate never goes live without an admin's Approve click.
        ("tariff", "tc", "Tariff", fetch_tariff_rate,
         "TARIFF FINDER IS CHECKING NOW // https://finder.tariffcommission.gov.ph",
         "Tariff Finder check failed — check logs above."),
        ("psa", "psa", "PSA", fetch_psa_monthly,
         "PSA OPENSTAT IS CHECKING NOW // https://openstat.psa.gov.ph (rice stocks, palay farmgate)",
         "PSA OpenSTAT refresh failed or was refused — kept the stored copy."),
        ("cpi", "cpi", "CPI", fetch_core_inflation,
         "PSA CORE INFLATION IS CHECKING NOW // https://openstat.psa.gov.ph (core CPI, year-on-year %)",
         "PSA core inflation refresh failed or was refused — kept the stored copy."),
        ("wb", "wb", "WB", fetch_world_rice,
         "WORLD BANK RICE PRICE IS CHECKING NOW // https://www.worldbank.org/en/research/commodity-markets "
         "(Pink Sheet, Rice Viet Namese 5%)",
         "World Bank rice price refresh failed or was refused — kept the stored copy."),
    ]
    results: dict = {}

    try:
        if not _SCRAPER_AVAILABLE:
            logger.error("Scraper modules not installed: %s", _SCRAPER_IMPORT_ERROR)
            logger.info("Install: pip install pdfplumber requests beautifulsoup4")
            _add_log("ERROR", f"Scraper import failed: {_SCRAPER_IMPORT_ERROR}")
            _last_scrape_ok = False
            return False

        _add_log("INFO", "Scrape job started (rice → fuel → exchange rates → tariff → PSA → core inflation → world rice)")
        logger.info("SCRAPPING IS INITIATING...")

        for key, sid, _label, fn, start_msg, fail_msg in steps:
            if sid in skip:
                results[key] = None
                logger.info("%s skipped — switched off in Admin → Settings.", sid.upper())
                continue
            logger.info(start_msg)
            try:
                ok = bool(fn())
                results[key] = ok
                if ok:
                    _last_source_ts[sid] = datetime.now()
                else:
                    logger.warning(fail_msg)
            except Exception as exc:
                results[key] = False
                logger.error("FAILED AT %s: %s", sid.upper(), exc)

        # ── Summary ──────────────────────────────────────────────────────────
        ran = [v for v in results.values() if v is not None]
        any_ok = any(ran)
        all_ok = bool(ran) and all(ran)

        logger.info("")
        logger.info("---------------------------------------")
        logger.info("  SUMMARY")
        for key, _sid, label, *_ in steps:
            v = results.get(key)
            logger.info("  %-6s : %s", label, "SKIPPED" if v is None else ("OK" if v else "FAILED"))
        if all_ok:
            logger.info("  Status : All datasets updated successfully.")
        elif any_ok:
            logger.warning("  Status : Partial success - some datasets may be outdated.")
        else:
            logger.error("  Status : All scrapes failed. Check your network connection.")
        logger.info("---------------------------------------")

        _last_scrape_ts = datetime.now()
        _last_scrape_ok = any_ok
        _add_log("INFO", "Scrape job finished.")
        if any_ok:
            _export_factor_files()
            _refresh_forecast_async()
        return any_ok

    except Exception as exc:
        logger.error("Unexpected scrape error: %s", exc)
        _add_log("ERROR", f"Scrape failed: {exc}")
        _last_scrape_ok = False
        return False
    finally:
        _release_scrape_lock()


def _export_factor_files() -> None:
    """Refresh datasets/1_factor_csv (one CSV per factor) and datasets/2_backup_database/by_factor (one SQLite copy
    per factor) from the database after a scrape. Never fails the scrape."""
    try:
        from export_factors import export_all
        written = export_all(verbose=False)
        logging.getLogger("agriprice_scraper").info("Factor CSVs and per-factor backups refreshed (%s files).", written)
    except Exception as exc:
        logging.getLogger("agriprice_scraper").warning("Factor export skipped: %s", exc)


def _do_scrape_one(source_id: str) -> bool:
    """Run scraper for a single source (da | doe | api | tc | psa | cpi | wb)."""
    global _scrape_running, _last_scrape_ts, _last_scrape_ok, _scrape_started_at

    fetch_map = {
        "da":  fetch_rice_prices,
        "doe": fetch_fuel_prices,
        "api": fetch_exchange_rates,
        "tc":  fetch_tariff_rate,
        "psa": fetch_psa_monthly,
        "cpi": fetch_core_inflation,
        "wb":  fetch_world_rice,
    }
    fn = fetch_map.get(source_id)
    if not fn:
        return False

    with _scrape_lock:
        if _scrape_running:
            logging.getLogger("agriprice_scraper").warning(
                "Scrape already running — skipping %s.", source_id
            )
            return False
        _scrape_running = True
        _scrape_started_at = datetime.now()

    logger = logging.getLogger("agriprice_scraper")
    try:
        _add_log("INFO", f"Single-source scrape started: {source_id}")
        logger.info("Single-source scrape started: %s", source_id)
        ok = bool(fn())
        if ok:
            _last_source_ts[source_id] = datetime.now()
            if source_id != "tc":           # a tariff candidate never changes the model's inputs
                _export_factor_files()
                _refresh_forecast_async()
        _last_scrape_ts = datetime.now()
        _last_scrape_ok = ok
        return ok
    except Exception as exc:
        logger.error("Single-source scrape failed (%s): %s", source_id, exc)
        _add_log("ERROR", f"Scrape failed ({source_id}): {exc}")
        _last_scrape_ok = False
        return False
    finally:
        _release_scrape_lock()


# ── Auto-scrape scheduler ─────────────────────────────────────────────────────
# A full sync (every source) runs every `scrape_interval_hours` (Admin → Settings; default 24). Between syncs,
# while today's DA bulletin is still missing, DA alone is retried every DA_RETRY_SECONDS during DA_RETRY_HOURS:
# DA posts during the day, and a once-a-day sync that happened to run early left the site on a temporary
# estimate until the next day.
DA_RETRY_SECONDS = 2 * 60 * 60
DA_RETRY_HOURS = (7, 21)          # local time window for DA retries
_schedule: dict = {"auto": True, "interval_hours": None, "next_full": None,
                   "da_waiting": False, "next_da_retry": None, "disabled": []}


def _scrape_settings() -> dict:
    try:
        from settings_store import get_settings
        return (get_settings().get("settings") or {}).get("data_sources") or {}
    except Exception:
        return {}


def _da_official_today() -> bool:
    """True once today's DA bulletin (not a temporary estimate) is in WS_rice_price."""
    try:
        conn = sqlite3.connect(DB_PATH)
        try:
            cols = [r[1] for r in conn.execute('PRAGMA table_info("WS_rice_price")')]
            today = datetime.now().strftime("%m/%d/%Y")
            if "Source" in cols:
                row = conn.execute('SELECT 1 FROM "WS_rice_price" WHERE Date = ? AND '
                                   "LOWER(COALESCE(Source, 'da_official')) != 'estimated' LIMIT 1", (today,)).fetchone()
            else:
                row = conn.execute('SELECT 1 FROM "WS_rice_price" WHERE Date = ? LIMIT 1', (today,)).fetchone()
            return row is not None
        finally:
            conn.close()
    except Exception:
        return True   # can't tell: don't hammer DA


def _loop_scraper(interval: int) -> None:
    """Background auto-scrape loop. Used in --loop and server modes.

    `interval` (seconds) comes from --interval; when left at the default, Admin → Settings decides
    (`scrape_interval_hours`). `auto_scrape` off pauses automatic runs (manual "Run scraper" still works),
    and a source switched off in Settings is skipped by the automatic sync.
    """
    logger = logging.getLogger("agriprice_scraper")
    logger.info("Auto-scraper loop started (full sync every %s h unless Settings says otherwise; "
                "DA retried every %s h until today's bulletin arrives).", interval // 3600, DA_RETRY_SECONDS // 3600)
    time.sleep(15)   # let Flask respond before the first scrape (avoids "stuck on Running" on page load)
    next_full = time.time()
    last_da_try = 0.0
    while True:
        ds = _scrape_settings()
        auto = ds.get("auto_scrape", True) is not False
        hours = ds.get("scrape_interval_hours")
        every = interval if interval != DEFAULT_INTERVAL or not isinstance(hours, (int, float)) or hours <= 0 \
            else int(hours * 3600)
        disabled = [k for k, flag in (("da", "da_enabled"), ("doe", "fuel_enabled"), ("api", "exchange_enabled"),
                                      ("psa", "psa_enabled")) if ds.get(flag, True) is False]
        now = time.time()
        hour = datetime.now().hour
        try:
            if auto and now >= next_full:
                _do_scrape(skip=disabled)
                next_full = time.time() + every
                last_da_try = time.time()
            elif (auto and "da" not in disabled and DA_RETRY_HOURS[0] <= hour < DA_RETRY_HOURS[1]
                  and now - last_da_try >= DA_RETRY_SECONDS and not _scrape_running and not _da_official_today()):
                logger.info("Today's DA bulletin is not in yet — retrying DA only.")
                _do_scrape_one("da")
                last_da_try = time.time()
        except Exception as exc:
            logger.error("Auto-scrape loop error: %s", exc)

        da_waiting = auto and "da" not in disabled and not _da_official_today()
        retry = None
        if da_waiting:
            retry = datetime.fromtimestamp(max(last_da_try + DA_RETRY_SECONDS, time.time()))
            if retry.hour >= DA_RETRY_HOURS[1]:
                retry = (retry + timedelta(days=1)).replace(hour=DA_RETRY_HOURS[0], minute=0, second=0)
            elif retry.hour < DA_RETRY_HOURS[0]:
                retry = retry.replace(hour=DA_RETRY_HOURS[0], minute=0, second=0)
        _schedule.update({
            "auto": auto, "interval_hours": round(every / 3600, 2), "disabled": disabled,
            "next_full": datetime.fromtimestamp(next_full).isoformat(timespec="seconds") if auto else None,
            "da_waiting": da_waiting,
            "next_da_retry": retry.isoformat(timespec="seconds") if retry else None,
        })
        time.sleep(60)


# ─── CSV / DB helpers ─────────────────────────────────────────────────────────
def _sanitize_for_json(value):
    """Recursively replace NaN/Inf so browser JSON.parse() never fails."""
    if isinstance(value, dict):
        return {k: _sanitize_for_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_sanitize_for_json(v) for v in value]
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    try:
        import numpy as np
        if isinstance(value, (np.floating, np.integer)):
            v = float(value)
            if math.isnan(v) or math.isinf(v):
                return None
            return v
        if isinstance(value, np.bool_):
            return bool(value)
    except ImportError:
        pass
    return value


def _df_to_json_records(df: pd.DataFrame) -> list[dict]:
    """DataFrame → list[dict]; NaN becomes null (not bare NaN)."""
    if df.empty:
        return []
    return json.loads(df.to_json(orient="records"))


def _row_count(path: str) -> int:
    """Fast line count of a CSV (excludes header)."""
    if not os.path.exists(path):
        return 0
    try:
        return max(0, sum(1 for _ in open(path)) - 1)
    except Exception:
        return 0


def _count_table_rows(sql: str) -> int:
    if not os.path.exists(DB_PATH):
        return 0
    try:
        conn = sqlite3.connect(DB_PATH)
        n = conn.execute(f"SELECT COUNT(*) FROM ({sql})").fetchone()[0]
        conn.close()
        return int(n)
    except Exception:
        return 0


def _count_merged_dates(hist_sql: str, ws_sql: str) -> int:
    if not os.path.exists(DB_PATH):
        return 0
    frames = []
    try:
        conn = sqlite3.connect(DB_PATH)
        for sql in (hist_sql, ws_sql):
            try:
                df = pd.read_sql(sql, conn)
                if not df.empty and "Date" in df.columns:
                    frames.append(df["Date"])
            except Exception:
                pass
        conn.close()
    except Exception:
        return 0
    if not frames:
        return 0
    # Parse each table on its own: the historical tables store "2025-12-29 00:00:00" and the scraped ones
    # "12/03/2024". Parsed together, pandas inferred one format and silently dropped every row in the other,
    # so e.g. the fuel card said 575 records (history only) instead of 667.
    dates = pd.concat([pd.to_datetime(f.astype(str), errors="coerce", format="mixed") for f in frames],
                      ignore_index=True).dropna()
    if dates.empty:
        return 0
    return int(dates.dt.normalize().nunique())


def _infer_source_fetch_time(source_id: str) -> datetime | None:
    ts = _last_source_ts.get(source_id)
    if ts:
        return ts
    meta = SOURCE_META.get(source_id)
    if meta and os.path.exists(meta["csv"]):
        return datetime.fromtimestamp(os.path.getmtime(meta["csv"]))
    return None


def _format_fetch_timestamp(ts: datetime | None, stat: dict) -> str:
    if ts:
        return ts.strftime("%b %d, %Y at %H:%M")
    if stat.get("is_today") and stat.get("latest_date"):
        return f"Today ({stat['latest_date']})"
    if stat.get("latest_date"):
        return str(stat["latest_date"])
    return "Never"


def _relative_time(ts: datetime | None) -> str:
    if not ts:
        return "Never"
    secs = int((datetime.now() - ts).total_seconds())
    if secs < 0:
        return "Just now"
    if secs < 60:
        return f"{secs}s ago"
    if secs < 3600:
        return f"{secs // 60} min ago"
    if secs < 86400:
        return f"{secs // 3600} hr ago"
    return f"{secs // 86400} day ago"


_SOURCE_LABELS = {
    "estimated": "Estimated (temporary)",
    "da_official": "DA official",
    "doe_ncr_weekly": "DOE weekly NCR bulletin",
    "gaswatchph": "GasWatch PH (fallback)",
}


def _build_row_summary(latest: dict, expected_cols: list) -> list:
    """Human-readable field list from the latest DB row (for modal detail)."""
    out: list[dict] = []
    date_val = latest.get("Date")
    if date_val is not None and not (isinstance(date_val, float) and pd.isna(date_val)):
        out.append({"label": "Date", "value": str(date_val)})

    src = latest.get("Source")
    if src is not None and not (isinstance(src, float) and pd.isna(src)):
        label = _SOURCE_LABELS.get(str(src).strip().lower(), str(src))
        out.append({"label": "Source", "value": label})
    filled = latest.get("Filled")
    if isinstance(filled, str) and filled.strip():
        # DOE left these blank; the value shown is GasWatch PH's for the same week.
        out.append({"label": "Filled from GasWatch PH",
                    "value": ", ".join(f.replace("_", " ") for f in filled.split(","))})

    for col in expected_cols:
        val = latest.get(col)
        if val is None or (isinstance(val, float) and pd.isna(val)) or val == "":
            continue
        if isinstance(val, float):
            val = round(val, 4)
        out.append({"label": col, "value": val})
    return out


def _get_latest_completeness_db(table_name: str, expected_cols: list) -> dict:
    """
    Checks the most recent row of `table_name` in the SQLite DB and reports
    how many of `expected_cols` have non-null values.
    """
    empty = {
        "count": 0, "missing": expected_cols, "latest_date": None,
        "is_today": False, "is_estimated": False, "source": None, "summary": [],
    }
    if not os.path.exists(DB_PATH):
        return empty
    try:
        conn  = sqlite3.connect(DB_PATH)
        df    = pd.read_sql(f'SELECT * FROM "{table_name}"', conn)
        conn.close()

        if df.empty:
            return empty

        df["_date_sort"] = pd.to_datetime(df["Date"], errors="coerce")
        df = df.sort_values("_date_sort", ascending=False).drop(columns=["_date_sort"])
        df = df.head(1)

        if df.empty:
            return empty

        latest     = df.iloc[0].to_dict()
        today_str  = datetime.now().strftime("%Y-%m-%d")

        try:
            parsed_date  = pd.to_datetime(str(latest.get("Date", ""))).strftime("%Y-%m-%d")
            display_date = pd.to_datetime(str(latest.get("Date", ""))).strftime("%m/%d/%Y")
        except Exception:
            parsed_date  = ""
            display_date = ""

        missing = [
            col for col in expected_cols
            if col not in latest or pd.isna(latest[col]) or latest[col] == ""
        ]
        summary = _build_row_summary(latest, expected_cols)
        row_source = str(latest.get("Source") or "da_official").strip().lower()
        is_estimated = row_source == "estimated"
        return {
            "count":       len(expected_cols) - len(missing),
            "missing":     missing,
            "latest_date": display_date,
            "is_today":    parsed_date == today_str,
            "is_estimated": is_estimated,
            "source":      "estimated" if is_estimated else "da_official",
            "summary":     summary,
        }
    except Exception:
        return empty


# ─── Flask App ────────────────────────────────────────────────────────────────
from flask.json.provider import DefaultJSONProvider


class _SafeJSONProvider(DefaultJSONProvider):
    """Never emit bare NaN/Infinity — breaks fetch().json() in browsers."""

    def dumps(self, obj, **kwargs):
        kwargs.setdefault("allow_nan", False)
        return super().dumps(_sanitize_for_json(obj), **kwargs)


app = Flask(__name__)
app.json = _SafeJSONProvider(app)
# App-wide request body ceiling (defense-in-depth on top of the per-file size check in the brand
# image upload route below) — nothing else in this API accepts a body anywhere near this size.
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024
# Restrict cross-origin access. `CORS(app)` with no arguments emits
# `Access-Control-Allow-Origin: *`, letting any site on the internet call this API from a
# visitor's browser — including the admin-adjacent endpoints. The frontend is served by this same
# Flask process, so same-origin needs no CORS at all; the allowlist exists only for the documented
# XAMPP / Live Server setup. Override with AGRIPRICE_CORS_ORIGINS (comma-separated) when deploying.
_CORS_ORIGINS = [
    o.strip() for o in os.environ.get(
        "AGRIPRICE_CORS_ORIGINS",
        "http://127.0.0.1:5000,http://localhost:5000,"
        "http://127.0.0.1:5500,http://localhost:5500,"
        "http://127.0.0.1,http://localhost",
    ).split(",") if o.strip()
]
CORS(app, resources={r"/api/*": {"origins": _CORS_ORIGINS}}, supports_credentials=True)

# Browser security headers on every response.
#  * frame-ancestors / X-Frame-Options: no other site can load these pages in a frame and trick an
#    admin into clicking (clickjacking).
#  * The Content-Security-Policy lists the only places scripts, styles, fonts and API calls may come
#    from: this server, the Chart.js/icon CDNs, Google Fonts and Google sign-in. Inline scripts are
#    still allowed ('unsafe-inline') because the pages use them; a script from any other site is not.
#  * Images may come from any https host (rice photos are hot-linked from several photo sites).
_CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://accounts.google.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://accounts.google.com",
    "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' " + " ".join(sorted(set(_CORS_ORIGINS))) + " https://accounts.google.com",
    "frame-src https://accounts.google.com",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
])


_PRIVATE_API_PREFIXES = ("/api/auth/", "/api/admin/", "/api/settings", "/api/logs", "/api/alerts")


@app.after_request
def _security_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    resp.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    # Google's sign-in popup needs to talk back to the page that opened it.
    resp.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin-allow-popups")
    if (resp.mimetype or "").startswith("text/html"):
        resp.headers.setdefault("Content-Security-Policy", _CSP)
    # Answers that carry account or admin data are never stored by the browser or a proxy.
    if request.path.startswith(_PRIVATE_API_PREFIXES) and "Cache-Control" not in resp.headers:
        resp.headers["Cache-Control"] = "no-store"
    return resp


def _auto_import_2026() -> None:
    """I-merge ang 2026 XLSX sa database kapag nag-start ang server."""
    try:
        from import_2026 import import_all
        result = import_all(verbose=False)
        logging.getLogger("agriprice_scraper").info(
            "2026 data sync OK (latest rice DB date synced; today=%s)",
            result.get("today"),
        )
    except Exception as exc:
        logging.getLogger("agriprice_scraper").warning(
            "2026 data sync skipped: %s", exc
        )


# ── /api/health ───────────────────────────────────────────────────────────────
@app.route("/api/health", methods=["GET"])
def api_health():
    return jsonify({
        "status": "ok",
        "ts": datetime.now().isoformat(),
        "today": date.today().isoformat(),
        "db_path": DB_PATH,
        "db_exists": os.path.exists(DB_PATH),
    })


# ── /api/scrape-status ────────────────────────────────────────────────────────
@app.route("/api/scrape-status", methods=["GET"])
def api_scrape_status():
    """
    Returns:
      logs          – buffered log lines (newest last)
      stats         – row counts, completeness check, running flag, last run info
    """
    EXPECTED_RICE  = [
        "Local Special", "Local Premium", "Local Well Milled", "Local Regular Milled",
        "Imported Special", "Imported Premium", "Imported Well Milled", "Imported Regular Milled",
    ]
    EXPECTED_FUEL  = [
        "RON_97", "RON_95", "RON_91",
        "Diesel", "Diesel_Plus", "Kerosene",
    ]
    EXPECTED_RATES = ["USD_to_PHP", "THB_to_PHP", "VND_to_PHP"]

    _maybe_clear_stale_scrape()

    with _LOG_LOCK:
        logs = list(_LOG_BUFFER)

    calendar_today = datetime.now().strftime("%m/%d/%Y")
    stats = {
        "rice":        _get_latest_completeness_db("WS_rice_price", EXPECTED_RICE),
        "fuel":        _get_latest_completeness_db("WS_fuel",       EXPECTED_FUEL),
        "rates":       _get_latest_completeness_db("WS_currency",   EXPECTED_RATES),
        "rice_count":  _row_count(PRICE_CSV),
        "fuel_count":  _row_count(FUEL_CSV),
        "rates_count": _row_count(RATE_CSV),
        "calendar_today": calendar_today,
        "running":     _scrape_running,
        "last_run":    _last_scrape_ts.isoformat() if _last_scrape_ts else None,
        "last_ok":     _last_scrape_ok,
        # The auto-scraper's real plan (see _loop_scraper): next full sync, and whether DA is being retried.
        "schedule":    dict(_schedule, da_retry_hours=list(DA_RETRY_HOURS), da_retry_every_hours=DA_RETRY_SECONDS // 3600),
    }

    return jsonify({
        "logs":          logs,
        "stats":         stats,
    })


# ── /api/forecast-check ───────────────────────────────────────────────────────
# Data readiness checklist (model/data_pipeline.py): the newest day whose DA bulletin, fuel and USD/PHP
# inputs are all verified. Only days up to it are fed to the model; later days are listed with what is missing.
@app.route("/api/data-readiness", methods=["GET"])
def api_data_readiness():
    try:
        from data_pipeline import LAST_READINESS
        from predict import _get_merged_frame
        _get_merged_frame()   # (re)runs the checklist; the merged frame is cached for 90 s
        return jsonify({"ready": True, **LAST_READINESS})
    except Exception as exc:
        return jsonify({"ready": False, "error": str(exc)}), 503


# Forward evaluation of the published forecast: forecasts logged before their DA price existed, scored now
# (model/forecast_log.py). The clean check on days no experiment has ever seen.
@app.route("/api/forecast-check", methods=["GET"])
def api_forecast_check():
    try:
        import forecast_log
        return jsonify(forecast_log.score())
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── /api/scrape-review ────────────────────────────────────────────────────────
# Rice prices the scraper held back as suspicious (tools/scrape_guard.py): a price equal to the
# neighbouring grade's, or far from that grade's recent median. Reading the queue is open (it holds
# only public DA prices); approving or rejecting needs an admin session.
@app.route("/api/scrape-review", methods=["GET"])
def api_scrape_review():
    ok, resp = _require_admin()
    if not ok:
        return resp
    try:
        import scrape_guard
        return jsonify({"pending": scrape_guard.pending(), "guard_pct": scrape_guard.GUARD_PCT})
    except Exception as e:
        return jsonify({"pending": [], "error": str(e)}), 500


@app.route("/api/scrape-review/resolve", methods=["POST"])
def api_scrape_review_resolve():
    ok, resp = _require_admin()
    if not ok:
        return resp
    body = request.get_json(silent=True) or {}
    date_str = str(body.get("date") or "").strip()
    column = str(body.get("column") or "").strip()
    action = str(body.get("action") or "").strip().lower()
    try:
        import scrape_guard
        entry = scrape_guard.resolve(date_str, column, action, DB_PATH, PRICE_CSV)
    except (ValueError, KeyError) as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    _add_log("INFO", f"Scrape review: {action} {date_str} {column} = {entry.get('value')}", "REVIEW")
    return jsonify({"ok": True, "entry": entry})


def _build_live_source(
    source_id: str,
    name: str,
    stype: str,
    data_type: str,
    url: str,
    color: str,
    bg_color: str,
    ws_table: str,
    expected_cols: list,
    hist_sql: str,
    ws_sql: str,
) -> dict:
    stat = _get_latest_completeness_db(ws_table, expected_cols)
    hist_n = _count_table_rows(hist_sql)
    ws_n = _count_table_rows(ws_sql)
    total_unique = _count_merged_dates(hist_sql, ws_sql)
    fetch_ts = _infer_source_fetch_time(source_id)
    filled = int(stat.get("count", 0) or 0)
    has_calendar_today = bool(stat.get("is_today"))
    summary = stat.get("summary") or []

    # DA row Date = bulletin PDF date (often not calendar today) — full row still counts
    if source_id == "da":
        has_data_ready = has_calendar_today or filled >= 6
    else:
        has_data_ready = has_calendar_today or filled >= max(1, len(expected_cols) // 2)

    if _scrape_running:
        status = "running"
    elif total_unique > 0 or ws_n > 0:
        status = "active"
    else:
        status = "idle"

    return {
        "id": source_id,
        "name": name,
        "type": stype,
        "dataType": data_type,
        "status": status,
        "lastFetch": _format_fetch_timestamp(fetch_ts, stat),
        "lastFetchRelative": _relative_time(fetch_ts),
        "lastFetchAt": fetch_ts.isoformat() if fetch_ts else None,
        "hasDataToday": has_data_ready,
        "hasCalendarToday": has_calendar_today,
        "isEstimated": bool(stat.get("is_estimated")),
        "recordsToday": filled if has_data_ready else 0,
        "todaySummary": summary if has_data_ready else [],
        "dataSummary": summary,
        "historicalRecords": hist_n,
        "scrapedRecords": ws_n,
        "totalRecords": total_unique,
        "url": url,
        "color": color,
        "bgColor": bg_color,
        "live": True,
        "implemented": True,
    }


def _build_tariff_source() -> dict:
    """Data Sources card for the rice import tariff (Tariff Commission's Philippine Tariff
    Finder). Deliberately NOT built on _build_live_source: tariff_schedule is a small, quarterly
    table gated on admin review, not a daily WS_* row count, so "records today"/"completeness"
    don't mean anything here — this reads the table directly instead of forcing it through a
    shape it doesn't fit. "Records today" is repurposed as "candidates pending review" and the
    card's summary shows the current confirmed rate plus any pending one."""
    fetch_ts = _infer_source_fetch_time("tc")
    total = confirmed = staged_ever = 0
    pending: list[dict] = []
    current: dict | None = None
    if os.path.exists(DB_PATH):
        try:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            if conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='tariff_schedule'"
            ).fetchone():
                total = conn.execute("SELECT COUNT(*) FROM tariff_schedule").fetchone()[0]
                confirmed = conn.execute(
                    "SELECT COUNT(*) FROM tariff_schedule WHERE active=1"
                ).fetchone()[0]
                pending = [dict(r) for r in conn.execute(
                    "SELECT id,rate_pct,quarter_label,effective_start FROM tariff_schedule "
                    "WHERE active=0 AND entry_type='SCRAPED' ORDER BY effective_start DESC"
                )]
                cur_row = conn.execute(
                    "SELECT rate_pct,quarter_label,effective_start,effective_end FROM "
                    "tariff_schedule WHERE active=1 ORDER BY effective_start DESC LIMIT 1"
                ).fetchone()
                current = dict(cur_row) if cur_row else None
            if conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='tariff_audit'"
            ).fetchone():
                staged_ever = conn.execute(
                    "SELECT COUNT(*) FROM tariff_audit WHERE action='scrape_detect'"
                ).fetchone()[0]
            conn.close()
        except Exception:
            pass

    has_pending = bool(pending)
    if _scrape_running:
        status = "running"
    elif total > 0:
        status = "active"
    else:
        status = "idle"

    summary = []
    if current:
        summary = [
            {"label": "Current rate", "value": f"{current['rate_pct']}%"},
            {"label": "Quarter", "value": current.get("quarter_label") or "—"},
            {"label": "Effective",
             "value": f"{current.get('effective_start') or '?'} → {current.get('effective_end') or 'open'}"},
        ]
    if pending:
        p = pending[0]
        summary.append({"label": "Pending review", "value": f"{p['quarter_label']} @ {p['rate_pct']}%"})

    return {
        "id": "tc",
        "name": "Tariff Commission (PH Tariff Finder)",
        "type": "REST API (JSON)",
        "dataType": "Rice Import Tariff Rate (Quarterly, admin-approved)",
        "status": status,
        "lastFetch": _format_fetch_timestamp(fetch_ts, {}),
        "lastFetchRelative": _relative_time(fetch_ts),
        "lastFetchAt": fetch_ts.isoformat() if fetch_ts else None,
        "hasDataToday": has_pending,
        "hasCalendarToday": has_pending,
        "isEstimated": False,
        "recordsToday": len(pending),
        "todaySummary": summary,
        "dataSummary": summary,
        "historicalRecords": confirmed,
        "scrapedRecords": staged_ever,
        "totalRecords": total,
        "url": "https://finder.tariffcommission.gov.ph",
        "color": "#8B5CF6",
        "bgColor": "rgba(139,92,246,0.12)",
        "live": True,
        "implemented": True,
    }


def _build_psa_source() -> dict:
    """Data Sources card for PSA OpenSTAT: monthly national rice stocks inventory and palay farmgate price.
    A monthly source, so "up to date" means PSA has nothing newer, not a row dated today."""
    fetch_ts = _last_source_ts.get("psa")
    stocks = farmgate = meta = None
    try:
        conn = sqlite3.connect(DB_PATH)
        try:
            stocks = pd.read_sql('SELECT * FROM "PSA_rice_stocks" ORDER BY Date', conn)
            farmgate = pd.read_sql('SELECT * FROM "PSA_farmgate" ORDER BY Date', conn)
            meta = pd.read_sql('SELECT * FROM "PSA_meta"', conn)
        finally:
            conn.close()
    except Exception:
        pass
    if fetch_ts is None and meta is not None and not meta.empty:
        try:
            fetch_ts = datetime.fromisoformat(str(meta["fetched_at"].max()))
        except ValueError:
            fetch_ts = None

    summary: list[dict] = []
    latest_month = None
    if stocks is not None and not stocks.empty:
        last = stocks.iloc[-1]
        latest_month = pd.to_datetime(last["Date"])
        summary.append({"label": "Date", "value": latest_month.strftime("%B %Y")})
        summary.append({"label": "Source", "value": "PSA OpenSTAT"})
        for col, label in (("total", "Stock: total (MT)"), ("household", "Stock: household"),
                           ("commercial", "Stock: commercial"), ("nfa", "Stock: NFA")):
            if pd.notna(last.get(col)):
                summary.append({"label": label, "value": f"{float(last[col]):,.0f}"})
    if farmgate is not None and not farmgate.empty:
        last = farmgate.iloc[-1]
        for col, label in (("other_variety", "Farmgate: other (₱/kg)"),
                           ("fancy", "Farmgate: fancy (₱/kg)")):
            if pd.notna(last.get(col)):
                summary.append({"label": label, "value": f"{float(last[col]):.2f}"})
    # PSA publishes month M around the 7th-15th of M+1: "current" = last month or the one before it.
    current = latest_month is not None and (pd.Timestamp.now().normalize() - latest_month).days <= 75
    months = (len(stocks) if stocks is not None else 0) + (len(farmgate) if farmgate is not None else 0)
    return {
        "id": "psa",
        "name": "PSA OpenSTAT (Rice stocks & farmgate)",
        "type": "REST API (PXWeb JSON)",
        "dataType": "Rice stocks inventory & palay farmgate price (Monthly)",
        "status": "running" if _scrape_running else ("active" if months else "idle"),
        "lastFetch": _format_fetch_timestamp(fetch_ts, {}),
        "lastFetchRelative": _relative_time(fetch_ts),
        "lastFetchAt": fetch_ts.isoformat() if fetch_ts else None,
        "hasDataToday": bool(current),
        "hasCalendarToday": False,
        "isEstimated": False,
        "recordsToday": 0,
        "todaySummary": summary if current else [],
        "dataSummary": summary,
        "historicalRecords": len(stocks) if stocks is not None else 0,
        "scrapedRecords": len(farmgate) if farmgate is not None else 0,
        "totalRecords": months,
        "psaUpdated": {r["table"]: r["psa_updated"] for _, r in meta.iterrows()} if meta is not None else {},
        "url": "https://openstat.psa.gov.ph",
        "color": "#0EA5E9",
        "bgColor": "rgba(14,165,233,0.12)",
        "live": True,
        "implemented": True,
    }


_MACRO_SOURCES = {
    "cpi": {"table": "MACRO_core_inflation", "col": "core_inflation", "name": "PSA OpenSTAT (Core inflation)",
            "type": "REST API (PXWeb JSON)", "dataType": "Core inflation, year-on-year % (Monthly)",
            "source": "PSA OpenSTAT", "label": "Core inflation (%)", "fmt": "{:.1f}%",
            "extra": [("core_cpi", "Core CPI (2018=100)", "{:.1f}")],
            "url": "https://openstat.psa.gov.ph", "color": "#E11D48", "bgColor": "rgba(225,29,72,0.12)",
            "current_days": 75},
    "wb":  {"table": "MACRO_world_rice", "col": "viet5", "name": "World Bank Pink Sheet (World rice price)",
            "type": "Excel download (monthly XLSX)", "dataType": "Rice export price, Viet Nam 5% broken, US$/t (Monthly)",
            "source": "World Bank Pink Sheet", "label": "Viet Nam 5% (US$/t)", "fmt": "${:,.2f}",
            "extra": [("thai5", "Thai 5% (US$/t), reference only", "${:,.2f}")],
            "url": "https://www.worldbank.org/en/research/commodity-markets", "color": "#14B8A6",
            "bgColor": "rgba(20,184,166,0.12)", "current_days": 62},
}


def _build_macro_source(source_id: str) -> dict:
    """Data Sources card for one monthly economic factor (core inflation from PSA, world rice price from the
    World Bank). Monthly, so "up to date" means the source has nothing newer, not a row dated today."""
    d = _MACRO_SOURCES[source_id]
    fetch_ts = _last_source_ts.get(source_id)
    df = None
    try:
        with sqlite3.connect(DB_PATH) as conn:
            df = pd.read_sql(f'SELECT * FROM "{d["table"]}" ORDER BY Date', conn)
            if fetch_ts is None:
                try:
                    row = conn.execute('SELECT fetched_at FROM "MACRO_meta" WHERE "table" = ?', (d["table"],)).fetchone()
                    if row and row[0]:
                        fetch_ts = datetime.fromisoformat(row[0])
                except Exception:
                    pass
    except Exception:
        pass
    if fetch_ts is None:
        fetch_ts = _infer_source_fetch_time(source_id)

    summary: list[dict] = []
    latest_month = None
    if df is not None and not df.empty:
        last = df.iloc[-1]
        latest_month = pd.to_datetime(last["Date"])
        summary.append({"label": "Date", "value": latest_month.strftime("%B %Y")})
        summary.append({"label": "Source", "value": d["source"]})
        summary.append({"label": d["label"], "value": d["fmt"].format(float(last[d["col"]]))})
        if len(df) > 12:
            summary.append({"label": "Same month last year", "value": d["fmt"].format(float(df.iloc[-13][d["col"]]))})
        for col, label, fmt in d["extra"]:
            if col in df.columns and pd.notna(last.get(col)):
                summary.append({"label": label, "value": fmt.format(float(last[col]))})
        summary.append({"label": "Used by the model from",
                        "value": (latest_month + pd.DateOffset(months=1, days=14)).strftime("%b %d, %Y")})
    current = latest_month is not None and (pd.Timestamp.now().normalize() - latest_month).days <= d["current_days"]
    months = len(df) if df is not None else 0
    return {
        "id": source_id,
        "name": d["name"],
        "type": d["type"],
        "dataType": d["dataType"],
        "status": "running" if _scrape_running else ("active" if months else "idle"),
        "lastFetch": _format_fetch_timestamp(fetch_ts, {}),
        "lastFetchRelative": _relative_time(fetch_ts),
        "lastFetchAt": fetch_ts.isoformat() if fetch_ts else None,
        "hasDataToday": bool(current),
        "hasCalendarToday": False,
        "isEstimated": False,
        "recordsToday": 0,
        "todaySummary": summary if current else [],
        "dataSummary": summary,
        "historicalRecords": months,
        "scrapedRecords": months,
        "totalRecords": months,
        "firstMonth": pd.to_datetime(df["Date"].iloc[0]).strftime("%b %Y") if months else None,
        "latestMonth": latest_month.strftime("%b %Y") if latest_month is not None else None,
        "url": d["url"],
        "color": d["color"],
        "bgColor": d["bgColor"],
        "live": True,
        "implemented": True,
    }


@app.route("/api/data-sources", methods=["GET"])
def api_data_sources():
    """Live metadata for Data Sources page (historical + scraped DB counts)."""
    EXPECTED_RICE  = [
        "Local Special", "Local Premium", "Local Well Milled", "Local Regular Milled",
        "Imported Special", "Imported Premium", "Imported Well Milled", "Imported Regular Milled",
    ]
    EXPECTED_FUEL  = [
        "RON_97", "RON_95", "RON_91",
        "Diesel", "Diesel_Plus", "Kerosene",
    ]
    EXPECTED_RATES = ["USD_to_PHP", "THB_to_PHP", "VND_to_PHP"]

    sources = [
        _build_live_source(
            "da", "DA – Dept. of Agriculture",
            "Web Scraper (BeautifulSoup + PDF)",
            "Daily Rice Prices (8 types)",
            "https://www.da.gov.ph/price-monitoring/",
            "#4CAF6E", "rgba(76,175,110,0.12)",
            "WS_rice_price", EXPECTED_RICE,
            "SELECT Date FROM retail_prices",
            'SELECT Date FROM "WS_rice_price"',
        ),
        _build_live_source(
            "doe", "DOE – NCR Pump Prices (Fuel)",
            "Web Scraper (weekly DOE PDF)",
            "RON95 & Diesel common price, NCR (Weekly)",
            "https://doe.gov.ph/data-and-prices/liquid-fuels/retail-pump-prices/ncr-pump-prices",
            "#F59E0B", "rgba(245,158,11,0.12)",
            "WS_fuel", EXPECTED_FUEL,
            "SELECT Date FROM fuel_history",
            'SELECT Date FROM "WS_fuel"',
        ),
        _build_live_source(
            "api", "ExchangeRate API",
            "REST API (JSON)",
            "USD/PHP, THB/PHP, VND/PHP",
            "https://open.er-api.com/v6/latest/USD",
            "#3B82F6", "rgba(59,130,246,0.12)",
            "WS_currency", EXPECTED_RATES,
            'SELECT Date FROM usd_php_rates',
            'SELECT Date FROM "WS_currency"',
        ),
        _build_tariff_source(),
        _build_psa_source(),
        _build_macro_source("cpi"),
        _build_macro_source("wb"),
    ]

    active_count = sum(1 for s in sources if s["status"] in ("active", "running"))

    return jsonify({
        "sources": sources,
        "summary": {
            "total": len(sources),
            "active": active_count,
            "last_updated": _relative_time(_last_scrape_ts),
            "scraper_running": _scrape_running,
            "live": True,
        },
    })


# ── /api/run-scraper ──────────────────────────────────────────────────────────
@app.route("/api/run-scraper", methods=["POST"])
def api_run_scraper():
    """
    Triggers scrape in background. Optional JSON body: {"source": "da"|"doe"|"api"|"tc"|"psa"|"cpi"|"wb"}.
    """
    ok, resp = _require_admin()
    if not ok:
        return resp
    payload = request.get_json(silent=True) or {}
    source = (payload.get("source") or "").strip().lower() or None

    if source and source not in SOURCE_META:
        return jsonify({
            "success": False,
            "message": f"Source '{source}' is not available for scraping yet.",
        }), 400

    _maybe_clear_stale_scrape()

    if _scrape_running:
        return jsonify({
            "success": False,
            "message": "Scraper is already running — please wait.",
        }), 409

    _add_log("INFO", f"Manual scrape requested ({source or 'all sources'})")
    target = (lambda: _do_scrape_one(source)) if source else _do_scrape
    threading.Thread(target=target, daemon=True).start()

    label = source.upper() if source else "all sources"
    return jsonify({
        "success": True,
        "message": f"Scrape started for {label}.",
        "source": source,
    })


# ── /api/stream-scrape (SSE) ──────────────────────────────────────────────────
@app.route("/api/stream-scrape", methods=["GET"])
def api_stream_scrape():
    ok, resp = _require_admin()
    if not ok:
        return resp
    """
    Server-Sent Events endpoint.
    Subscribers receive every log line in real-time while a scrape runs.
    Existing buffer is replayed to new subscribers immediately on connect.
    """
    q: queue.Queue = queue.Queue(maxsize=500)
    with _SSE_LOCK:
        _SSE_QUEUES.append(q)

    def generate():
        try:
            # Replay existing buffer so the subscriber sees past logs right away
            with _LOG_LOCK:
                for entry in _LOG_BUFFER:
                    yield f"data: {json.dumps(entry)}\n\n"

            while True:
                try:
                    data = q.get(timeout=25)
                    yield f"data: {data}\n\n"
                except queue.Empty:
                    yield ": heartbeat\n\n"   # keep connection alive
        except GeneratorExit:
            pass
        finally:
            with _SSE_LOCK:
                if q in _SSE_QUEUES:
                    _SSE_QUEUES.remove(q)

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control":     "no-cache",
            "X-Accel-Buffering": "no",   # important when behind nginx
        },
    )


# ── /api/historical-data ──────────────────────────────────────────────────────
# Every public chart page loads this (~4,400 days × 10 series). Rebuilding it from SQLite + pandas
# took ~0.5 s and sent 342 KB uncompressed on every visit. The payload only changes when the
# database file does, so it is built once per database version, kept in memory as gzip-ready JSON,
# and tagged with an ETag: a browser that already has it gets a 304 with no body.
_HIST_CACHE: dict = {"key": None, "json": None, "gz": None, "etag": None}
_HIST_CACHE_LOCK = threading.Lock()


@app.route("/api/historical-data", methods=["GET"])
def get_historical_data():
    """Unified rice/fuel/exchange time series for the charts (cached per database version)."""
    import gzip
    import hashlib

    try:
        st = os.stat(DB_PATH)
        key = (int(st.st_mtime_ns), int(st.st_size))
    except OSError:
        key = None
    with _HIST_CACHE_LOCK:
        if key is None or _HIST_CACHE["key"] != key:
            payload = _build_historical_payload()
            if isinstance(payload, tuple):          # (error response, status)
                return payload
            body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            _HIST_CACHE.update(
                key=key, json=body, gz=gzip.compress(body, compresslevel=6),
                etag='"' + hashlib.sha1(body).hexdigest()[:20] + '"',
            )
        body, gz, etag = _HIST_CACHE["json"], _HIST_CACHE["gz"], _HIST_CACHE["etag"]

    if request.headers.get("If-None-Match") == etag:
        resp = app.response_class(status=304)
    elif "gzip" in (request.headers.get("Accept-Encoding") or "").lower():
        resp = app.response_class(gz, mimetype="application/json")
        resp.headers["Content-Encoding"] = "gzip"
        resp.headers["Vary"] = "Accept-Encoding"
    else:
        resp = app.response_class(body, mimetype="application/json")
    resp.headers["ETag"] = etag
    resp.headers["Cache-Control"] = "no-cache"      # always revalidate; the ETag makes that cheap
    return resp


def _build_historical_payload():
    """
    Merges historical DB tables with web-scraped tables and returns a unified
    time-series payload for the dashboard charts.
    """
    try:
        conn = sqlite3.connect(DB_PATH)
    except sqlite3.OperationalError as e:
        print(f"Error connecting to database: {e}")
        return jsonify({"error": "Could not connect to database."}), 500

    # ── 1. Rice prices ────────────────────────────────────────────────────────
    df_rice_hist = pd.read_sql(
        """
        SELECT Date,
            "Local Special"      AS locSpecial,
            "Local Premium"      AS locPremium,
            "Local Well-Milled"  AS locWellMilled,
            "Local Regular"      AS locRegular,
            "Imported Special"   AS impSpecial,
            "Imprted Premium"    AS impPremium,
            "Imported Well-Milled" AS impWellMilled,
            "Imported Regular"   AS impRegular
        FROM retail_prices
        """,
        conn,
    )

    try:
        df_rice_ws = pd.read_sql(
            """
            SELECT Date,
                "Local Special"          AS locSpecial,
                "Local Premium"          AS locPremium,
                "Local Well Milled"      AS locWellMilled,
                "Local Regular Milled"   AS locRegular,
                "Imported Special"       AS impSpecial,
                "Imported Premium"       AS impPremium,
                "Imported Well Milled"   AS impWellMilled,
                "Imported Regular Milled" AS impRegular
            FROM "WS_rice_price"
            """,
            conn,
        )
    except Exception:
        df_rice_ws = pd.DataFrame()

    df_rice = pd.concat([df_rice_hist, df_rice_ws], ignore_index=True)

    # ── 2. Fuel prices ────────────────────────────────────────────────────────
    df_fuel_hist = pd.read_sql("SELECT Date, Diesel AS fuel FROM fuel_history", conn)

    try:
        # Must stay Diesel, matching `fuel_history`'s Diesel column above: this single "fuel"
        # series is charted/labelled as "Diesel Price" on the admin dashboard. Reading RON_95
        # here spliced gasoline onto the tail of a diesel series (two different commodities in
        # one line, off by ~PHP 1.40 at the join) — the scraped table has Diesel, so use it.
        df_fuel_ws = pd.read_sql('SELECT Date, Diesel AS fuel FROM "WS_fuel"', conn)
    except Exception:
        df_fuel_ws = pd.DataFrame()

    df_fuel = pd.concat([df_fuel_hist, df_fuel_ws], ignore_index=True)

    # ── 3. Exchange rates ─────────────────────────────────────────────────────
    df_usd_hist = pd.read_sql(
        'SELECT Date, "USD to PHP" AS exchange FROM usd_php_rates', conn
    )

    try:
        df_usd_ws = pd.read_sql(
            'SELECT Date, USD_to_PHP AS exchange FROM "WS_currency"', conn
        )
    except Exception:
        df_usd_ws = pd.DataFrame()

    df_usd = pd.concat([df_usd_hist, df_usd_ws], ignore_index=True)
    conn.close()

    # ── 4. Merge by date ──────────────────────────────────────────────────────
    for df in [df_rice, df_fuel, df_usd]:
        if not df.empty:
            df["Date"] = pd.to_datetime(df["Date"], format="mixed")

    df_final = df_rice
    if not df_fuel.empty:
        df_final = pd.merge(df_final, df_fuel, on="Date", how="outer")
    if not df_usd.empty:
        df_final = pd.merge(df_final, df_usd, on="Date", how="outer")

    df_final = df_final.sort_values("Date").reset_index(drop=True)

    # Monthly economic factors (core inflation, world rice price), each placed on the day it became public —
    # the 15th of the following month, the same rule the model uses (data_pipeline.MONTHLY_RELEASE_LAG).
    for table, col, out in (("MACRO_core_inflation", "core_inflation", "core_inflation"),
                            ("MACRO_world_rice", "viet5", "rice_world")):
        try:
            with sqlite3.connect(DB_PATH) as mconn:
                m = pd.read_sql(f'SELECT Date, {col} AS {out} FROM "{table}" ORDER BY Date', mconn)
            m["Date"] = pd.to_datetime(m["Date"]) + pd.DateOffset(months=1, days=14)
            df_final = pd.merge_asof(df_final.sort_values("Date"), m.sort_values("Date"), on="Date", direction="backward")
        except Exception:
            pass

    df_final = df_final.ffill().bfill().fillna(0)

    # The same factors by the month they describe (no release lag), for Admin -> Price History: every day of month M
    # carries M's figure; days outside the published months stay empty (null).
    month_ref: dict = {}
    for table, col, out in (("MACRO_core_inflation", "core_inflation", "core_inflation_month"),
                            ("MACRO_world_rice", "viet5", "rice_world_month")):
        try:
            with sqlite3.connect(DB_PATH) as mconn:
                m = pd.read_sql(f'SELECT Date, {col} AS v FROM "{table}" ORDER BY Date', mconn)
            by_month = dict(zip(pd.to_datetime(m["Date"]).dt.to_period("M"), m["v"].astype(float)))
            month_ref[out] = [by_month.get(per) for per in df_final["Date"].dt.to_period("M")]
        except Exception:
            month_ref[out] = []

    df_final["Date"] = df_final["Date"].dt.strftime("%m/%d/%Y")

    # ── 5. Build response ─────────────────────────────────────────────────────
    return {
        "labels": df_final["Date"].tolist(),
        "historical": {
            "impSpecial":    df_final["impSpecial"].tolist(),
            "impPremium":    df_final["impPremium"].tolist(),
            "impWellMilled": df_final["impWellMilled"].tolist(),
            "impRegular":    df_final["impRegular"].tolist(),
            "locSpecial":    df_final["locSpecial"].tolist(),
            "locPremium":    df_final["locPremium"].tolist(),
            "locWellMilled": df_final["locWellMilled"].tolist(),
            "locRegular":    df_final["locRegular"].tolist(),
            "fuel":          df_final["fuel"].tolist()     if "fuel"     in df_final.columns else [],
            "exchange":      df_final["exchange"].tolist() if "exchange" in df_final.columns else [],
            "core_inflation": df_final["core_inflation"].tolist() if "core_inflation" in df_final.columns else [],
            "rice_world":    df_final["rice_world"].tolist() if "rice_world" in df_final.columns else [],
            **month_ref,
        },
    }




# ══════════════════════════════════════════════
# TRAINING ENDPOINTS
# ══════════════════════════════════════════════

import subprocess

# State ng training (katulad ng scraper state)
_train_running           = False
_train_cancel_requested  = False
_train_process: subprocess.Popen | None = None
_train_lock       = threading.Lock()
_train_log_buffer: deque = deque(maxlen=300)
_train_log_lock   = threading.Lock()
_train_sse_queues: list[queue.Queue] = []
_train_sse_lock   = threading.Lock()
_last_train_ts: datetime | None = None
_last_train_result: dict | None = None   # { epoch, train_loss, val_loss, mae, duration }
_last_saved_run: dict | None = None

TRAINING_HISTORY_PATH = os.path.join(MODEL_DIR, "training_history.json")
_TRAIN_EPOCH_RE = re.compile(
    r"\[EPOCH\]\s*(?:(\S+)\s*\|\s*)?(\d+)/(\d+)\s*\|\s*loss:\s*([\d.]+)\s*\|\s*val_loss:\s*([\d.]+)\s*\|\s*mae:\s*([\d.]+)",
    re.I,
)
_TRAIN_TARGET_RE = re.compile(r"\[TARGET\]\s*(\d+)/(\d+)\s+(\S+)", re.I)


def _json_safe(value):
    """Make values JSON-serializable (NaN/Inf break json.dump)."""
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return value
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json_safe(v) for v in value]
    return value


def _load_training_history() -> list[dict]:
    if not os.path.exists(TRAINING_HISTORY_PATH):
        return []
    try:
        with open(TRAINING_HISTORY_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def _save_training_history(runs: list[dict]) -> None:
    os.makedirs(MODEL_DIR, exist_ok=True)
    safe_runs = _json_safe(runs[-50:])
    with open(TRAINING_HISTORY_PATH, "w", encoding="utf-8") as f:
        json.dump(safe_runs, f, indent=2, allow_nan=False)


def _bootstrap_training_history_if_empty() -> None:
    """If user trained before history existed, surface latest meta.json as one row."""
    runs = _load_training_history()
    if runs:
        return
    meta = _read_model_meta()
    if not meta or meta.get("mae_peso") is None:
        return
    mtime = os.path.getmtime(os.path.join(MODEL_DIR, "meta.json"))
    completed = datetime.fromtimestamp(mtime)
    entry = {
        "id": "legacy-" + completed.strftime("%Y%m%d"),
        "started_at": completed.isoformat(),
        "completed_at": completed.isoformat(),
        "duration": "—",
        "duration_sec": 0,
        "ok": True,
        "backend": meta.get("backend", "—"),
        "epochs_planned": 100,
        "epochs_completed": 0,
        "final_train_loss": None,
        "final_val_loss": None,
        "final_mae": None,
        "mae_peso": meta.get("mae_peso"),
        "rmse_peso": meta.get("rmse_peso"),
        "accuracy_pct": meta.get("accuracy_pct"),
        "primary_accuracy_pct": meta.get("primary_accuracy_pct"),
        "avg_accuracy_pct": meta.get("avg_accuracy_pct"),
        # Honest headline metrics (meta v4+). `accuracy_pct` above is kept only so runs recorded
        # before v4 still render — that formula scores the naive baseline above the model.
        "hit_rate_pct": meta.get("hit_rate_pct"),
        "skill_vs_baseline_pct": meta.get("skill_vs_baseline_pct"),
        "movement_ratio": meta.get("movement_ratio"),
        "seed": meta.get("seed"),
        "split_policy": meta.get("split_policy"),
        "split_dates": meta.get("split_dates"),
        "flat_pct_by_split": meta.get("flat_pct_by_split"),
        "train_samples": meta.get("train_samples"),
        "test_samples": meta.get("test_samples"),
        "last_data_date": meta.get("last_date"),
        "target": meta.get("target", "locWellMilled"),
        "train_loss_curve": [],
        "val_loss_curve": [],
        "log_excerpt": ["[INFO] Imported from existing model metadata (pre-history runs)."],
        "legacy": True,
    }
    entry["insights"] = [
        "This run was recovered from the saved model on disk — epoch curves were not recorded.",
        "New training runs will appear here automatically with full loss curves and logs.",
    ]
    _save_training_history([entry])


def _read_model_meta() -> dict:
    meta_path = os.path.join(MODEL_DIR, "meta.json")
    if not os.path.exists(meta_path):
        return {}
    try:
        with open(meta_path, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def _meta_is_newer_than_run(meta: dict, run: dict | None) -> bool:
    """True when meta.json on disk post-dates the newest recorded training run."""
    if not meta:
        return False
    if not run:
        return True
    meta_path = os.path.join(MODEL_DIR, "meta.json")
    try:
        meta_mtime = datetime.fromtimestamp(os.path.getmtime(meta_path))
        run_at = datetime.fromisoformat(str(run.get("completed_at")))
    except (OSError, TypeError, ValueError):
        return False
    # A minute of slack: the web trigger writes meta.json moments before the history entry.
    return meta_mtime > run_at + timedelta(minutes=1)


def _run_from_meta(meta: dict, prev_run: dict | None) -> dict:
    """A synthetic run entry describing the model currently on disk (CLI-trained)."""
    meta_path = os.path.join(MODEL_DIR, "meta.json")
    try:
        completed = datetime.fromtimestamp(os.path.getmtime(meta_path)).isoformat()
    except OSError:
        completed = datetime.now().isoformat()
    entry = {
        "id": f"cli-{completed[:19].replace('-', '').replace(':', '').replace('T', '-')}",
        "completed_at": completed,
        "ok": True,
        "source": "meta.json (trained from the command line)",
        "backend": meta.get("backend"),
        "mae_peso": meta.get("mae_peso"),
        "rmse_peso": meta.get("rmse_peso"),
        "accuracy_pct": meta.get("accuracy_pct"),
        "avg_accuracy_pct": meta.get("avg_accuracy_pct"),
        "hit_rate_pct": meta.get("hit_rate_pct"),
        "skill_vs_baseline_pct": meta.get("skill_vs_baseline_pct"),
        "movement_ratio": meta.get("movement_ratio"),
        "seed": meta.get("seed"),
        "split_policy": meta.get("split_policy"),
        "split_dates": meta.get("split_dates"),
        "flat_pct_by_split": meta.get("flat_pct_by_split"),
        "train_samples": meta.get("train_samples"),
        "test_samples": meta.get("test_samples"),
        "last_data_date": meta.get("last_date"),
        "target": meta.get("target"),
        "trained_types": meta.get("trained_types") or list((meta.get("targets") or {}).keys()),
        "targets_meta": meta.get("targets") if isinstance(meta.get("targets"), dict) else {},
    }
    return _json_safe(entry)


def _build_training_insights(entry: dict, prev: dict | None) -> list[str]:
    insights: list[str] = []
    if not entry.get("ok"):
        excerpt = " ".join(entry.get("log_excerpt") or [])
        if "cancelled" in excerpt.lower():
            insights.append(
                "This run was stopped before completion. Partial epoch data is kept for reference — "
                "start a new training run when ready."
            )
        else:
            insights.append(
                "Training did not complete successfully. Review the log excerpt for errors, "
                "then verify the database and Python/TensorFlow setup before retrying."
            )
        return insights

    vl = entry.get("final_val_loss")
    if prev and prev.get("ok") and prev.get("final_val_loss") is not None and vl is not None:
        diff = float(prev["final_val_loss"]) - float(vl)
        if diff > 0.001:
            insights.append(
                f"Validation loss improved by {diff:.4f} vs the previous run — "
                "the model is learning in a healthier direction."
            )
        elif diff < -0.001:
            insights.append(
                f"Validation loss rose by {abs(diff):.4f} vs the previous run. "
                "Consider fresher data, feature review, or fewer epochs."
            )
        else:
            insights.append("Validation loss is stable compared to the previous run.")

    tl, vl = entry.get("final_train_loss"), entry.get("final_val_loss")
    if tl is not None and vl is not None and float(vl) > float(tl) * 1.25:
        insights.append(
            "Validation loss is notably higher than training loss — "
            "mild overfitting may be present; early stopping helps limit this."
        )

    # The measured day-1 hit rate, not the legacy accuracy_pct (98–99% for any model, the naive
    # "tomorrow = today" forecast included), which made every run read as "strong".
    hr = (entry.get("hit_rate_pct") or {}).get("1.00")
    hit1 = hr[0] if isinstance(hr, list) and hr else None
    skill = entry.get("skill_vs_baseline_pct")
    if hit1 is not None:
        vs = ""
        if skill is not None:
            vs = (f"; average error is {abs(skill):.1f}% {'lower' if skill > 0 else 'higher'} than "
                  "the naive \"tomorrow = today\" forecast")
        insights.append(
            f"{hit1:.1f}% of next-day forecasts landed within ₱1.00 of the real price on held-out data{vs}."
        )

    done = entry.get("epochs_completed") or 0
    planned = entry.get("epochs_planned") or 0
    if planned and done < planned * 0.9:
        insights.append(
            f"Stopped at epoch {done}/{planned} via early stopping — "
            "best weights were restored from the lowest validation loss."
        )

    curve = entry.get("val_loss_curve") or []
    if len(curve) >= 5:
        tail = curve[-5:]
        if all(tail[i] >= tail[i + 1] for i in range(len(tail) - 1)):
            insights.append(
                "Final epochs show decreasing validation loss — learning curve ended on a good trajectory."
            )
        elif tail[-1] > tail[0]:
            insights.append(
                "Validation loss ticked up near the end — early stopping likely prevented worse generalization."
            )

    if not insights:
        insights.append("Run completed; compare validation loss and MAE with earlier runs in the learning path chart.")
    return insights


def _append_training_run(
    *,
    started_at: datetime,
    ok: bool,
    duration_sec: int,
    epoch_snapshots: list[dict],
    log_lines: list[str],
) -> dict:
    runs = _load_training_history()
    prev = runs[-1] if runs else None
    meta = _read_model_meta() if ok else {}

    epochs_planned = 100
    final_train = final_val = final_mae = None
    train_curve: list[float] = []
    val_curve: list[float] = []

    for snap in epoch_snapshots:
        epochs_planned = int(snap.get("total") or epochs_planned)
        try:
            train_curve.append(float(snap["loss"]))
            val_curve.append(float(snap["val_loss"]))
            final_train = float(snap["loss"])
            final_val = float(snap["val_loss"])
            final_mae = float(snap["mae"])
        except (KeyError, TypeError, ValueError):
            continue

    entry = {
        "id": started_at.strftime("%Y%m%d-%H%M%S"),
        "started_at": started_at.isoformat(),
        "completed_at": datetime.now().isoformat(),
        "duration": f"{duration_sec // 60}m {duration_sec % 60}s",
        "duration_sec": duration_sec,
        "ok": ok,
        "backend": meta.get("backend", "—"),
        "epochs_planned": epochs_planned,
        "epochs_completed": epoch_snapshots[-1]["epoch"] if epoch_snapshots else 0,
        "final_train_loss": final_train,
        "final_val_loss": final_val,
        "final_mae": final_mae,
        "mae_peso": meta.get("mae_peso"),
        "rmse_peso": meta.get("rmse_peso"),
        "accuracy_pct": meta.get("accuracy_pct"),
        "primary_accuracy_pct": meta.get("primary_accuracy_pct"),
        "avg_accuracy_pct": meta.get("avg_accuracy_pct"),
        # Honest headline metrics (meta v4+). `accuracy_pct` above is kept only so runs recorded
        # before v4 still render — that formula scores the naive baseline above the model.
        "hit_rate_pct": meta.get("hit_rate_pct"),
        "skill_vs_baseline_pct": meta.get("skill_vs_baseline_pct"),
        "movement_ratio": meta.get("movement_ratio"),
        "seed": meta.get("seed"),
        "split_policy": meta.get("split_policy"),
        "split_dates": meta.get("split_dates"),
        "flat_pct_by_split": meta.get("flat_pct_by_split"),
        "train_samples": meta.get("train_samples"),
        "test_samples": meta.get("test_samples"),
        "last_data_date": meta.get("last_date"),
        "target": meta.get("target", "locWellMilled"),
        "trained_types": meta.get("trained_types") or list((meta.get("targets") or {}).keys()),
        "targets_meta": meta.get("targets") if isinstance(meta.get("targets"), dict) else {},
        "train_loss_curve": train_curve,
        "val_loss_curve": val_curve,
        "log_excerpt": log_lines[-30:],
    }
    entry["insights"] = _build_training_insights(entry, prev)
    entry = _json_safe(entry)
    runs.append(entry)
    _save_training_history(runs)
    return entry


def _training_python_argv() -> list[str]:
    """Argv prefix for training subprocess (includes TensorFlow when available)."""
    candidates = [
        os.environ.get("AGRIPRICE_PYTHON"),
        ["py", "-3.13"],
        ["py", "-3.12"],
        ["py", "-3.11"],
        [sys.executable],
        ["python"],
    ]
    for parts in candidates:
        if not parts or not parts[0]:
            continue
        if isinstance(parts, str):
            parts = parts.split()
        try:
            r = subprocess.run(
                parts + ["-c", "import tensorflow"],
                capture_output=True,
                timeout=45,
            )
            if r.returncode == 0:
                return parts
        except Exception:
            continue
    return [sys.executable]


def _broadcast_train_sse(entry: dict) -> None:
    data = json.dumps(entry)
    with _train_sse_lock:
        dead = []
        for q in _train_sse_queues:
            try:
                q.put_nowait(data)
            except queue.Full:
                dead.append(q)
        for q in dead:
            _train_sse_queues.remove(q)


def _train_log_level(line: str) -> str:
    """Classify a subprocess line without false ERROR on `errors=\"coerce\"`."""
    s = line.strip()
    if not s:
        return "INFO"
    if s.startswith("[ERROR]") or s.startswith("Traceback"):
        return "ERROR"
    if s.startswith("[WARN]") or "UserWarning:" in s or s.startswith("warnings.warn("):
        return "WARN"
    if s.startswith("[DONE]") or s.startswith("[SAVED]") or s.startswith("[SUCCESS]"):
        return "SUCCESS"
    if s.startswith("[EPOCH]") or s.startswith("[INFO]"):
        return "INFO"
    upper = s.upper()
    if "FAILED" in upper or "EXCEPTION" in upper:
        return "ERROR"
    if "WARNING" in upper or " WARN " in f" {upper} ":
        return "WARN"
    return "INFO"


def _add_train_log(level: str, msg: str, extra: dict | None = None) -> None:
    entry = {
        "time":  datetime.now().strftime("%I:%M:%S %p"),
        "level": level,
        "msg":   msg,
    }
    if extra:
        entry.update(extra)
    with _train_log_lock:
        _train_log_buffer.append(entry)
    _broadcast_train_sse(entry)


def _clear_train_logs() -> None:
    with _train_log_lock:
        _train_log_buffer.clear()


def _do_training() -> bool:
    """
    Runs the LSTM training script as a subprocess.
    Caller must set _train_running=True and clear logs before starting the worker thread.
    """
    global _last_train_ts, _last_train_result, _last_saved_run, _train_process, _train_cancel_requested

    TRAIN_SCRIPT = os.path.join(MODEL_DIR, "train.py")
    py_argv = _training_python_argv()

    _add_train_log("INFO", "=" * 35)
    _add_train_log("INFO", "  LSTM TRAINING STARTED")
    _add_train_log("INFO", f"  Script: {TRAIN_SCRIPT}")
    _add_train_log("INFO", f"  Python: {' '.join(py_argv)}")
    _add_train_log("INFO", "=" * 35)

    start_time = time.time()
    started_at = datetime.now()
    epoch_snapshots: list[dict] = []
    session_log_lines: list[str] = []

    try:
        train_env = os.environ.copy()
        train_env.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
        train_env.setdefault("PYTHONWARNINGS", "ignore::UserWarning")
        if _SETTINGS_AVAILABLE:
            try:
                from settings_store import _load_raw
                model_cfg = _load_raw().get("model") or {}
                epochs = model_cfg.get("training_epochs")
                if epochs:
                    train_env["AGRIPRICE_EPOCHS"] = str(int(epochs))
                target = (model_cfg.get("target_rice") or "locWellMilled").strip()
                if target:
                    train_env["AGRIPRICE_TRAIN_TARGET"] = target
                train_all = model_cfg.get("train_all_rice_types", True)
                if train_all:
                    train_env["AGRIPRICE_TRAIN_ALL"] = "1"
                    _add_train_log(
                        "INFO",
                        "Training all 8 rice types "
                        f"(up to {epochs or 100} epochs each, early stopping).",
                    )
                else:
                    train_env["AGRIPRICE_TRAIN_ALL"] = "0"
                    train_env["AGRIPRICE_TRAIN_TARGET"] = target
                    _add_train_log(
                        "INFO",
                        f"Quick training: {target} only "
                        "(enable “Train all 8 rice types” in Settings for full training).",
                    )
            except Exception:
                pass

        process = subprocess.Popen(
            py_argv + [TRAIN_SCRIPT],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            cwd=MODEL_DIR,
            env=train_env,
        )
        _train_process = process

        for line in process.stdout:
            if _train_cancel_requested:
                break
            line = line.rstrip()
            if not line:
                continue
            _add_train_log(_train_log_level(line), line)
            session_log_lines.append(line)
            m = _TRAIN_EPOCH_RE.search(line)
            if m:
                epoch_snapshots.append({
                    "target": m.group(1) or "",
                    "epoch": int(m.group(2)),
                    "total": int(m.group(3)),
                    "loss": float(m.group(4)),
                    "val_loss": float(m.group(5)),
                    "mae": float(m.group(6)),
                })

        if _train_cancel_requested and process.poll() is None:
            try:
                process.kill()
            except OSError:
                process.terminate()
            try:
                process.wait(timeout=12)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        elif process.poll() is None:
            process.wait()
        ok = (process.returncode == 0) and not _train_cancel_requested

    except FileNotFoundError:
        _add_train_log("ERROR", f"Training script not found: {TRAIN_SCRIPT}")
        _add_train_log("INFO",  "Tip: I-adjust ang TRAIN_SCRIPT sa app.py → _do_training()")
        ok = False
    except Exception as exc:
        _add_train_log("ERROR", f"Training error: {exc}")
        ok = False

    elapsed = time.time() - start_time
    mins    = int(elapsed // 60)
    secs    = int(elapsed % 60)

    if _train_cancel_requested:
        _add_train_log("WARN", f"Training cancelled after {mins}m {secs}s — partial progress saved to history.")
        ok = False
    elif ok:
        _add_train_log("SUCCESS", f"Training complete! Duration: {mins}m {secs}s")
        try:
            from predict import invalidate_caches, warm_payload
            invalidate_caches()
            # Visitors keep getting the previous forecast until this finishes (model/predict.py).
            threading.Thread(target=warm_payload, daemon=True).start()
            _add_train_log("INFO", "Rebuilding the published forecast with the new weights in the background.")
        except Exception:
            pass
    else:
        _add_train_log("ERROR", f"Training failed after {mins}m {secs}s")

    _add_train_log("INFO", "=" * 35)

    _last_train_ts     = datetime.now()
    _last_train_result = {
        "duration": f"{mins}m {secs}s",
        "ok": ok,
        "cancelled": bool(_train_cancel_requested),
    }

    saved_entry = None
    _last_saved_run = None
    try:
        saved_entry = _append_training_run(
            started_at=started_at,
            ok=ok,
            duration_sec=int(elapsed),
            epoch_snapshots=epoch_snapshots,
            log_lines=session_log_lines,
        )
        _last_saved_run = saved_entry
        _add_train_log(
            "SUCCESS",
            f"Run saved to Training History ({saved_entry['id']}, "
            f"{len(epoch_snapshots)} epoch snapshots).",
        )
    except Exception as exc:
        logger.exception("Training history save failed")
        _add_train_log("WARN", f"Could not save training history: {exc}")

    _train_process = None
    return ok


def _training_worker() -> None:
    """Background thread — ensures running flag is cleared exactly once."""
    global _train_running, _train_cancel_requested, _train_process
    try:
        _do_training()
    except Exception as exc:
        logger.exception("Training worker failed: %s", exc)
        _add_train_log("ERROR", f"Training worker error: {exc}")
    finally:
        with _train_lock:
            _train_running = False
            _train_cancel_requested = False
            _train_process = None


def _training_history_summaries(runs_chronological: list[dict]) -> dict:
    """Newest-first OK runs for dashboard metrics and run-over-run comparison."""
    api_runs = list(reversed(runs_chronological))
    ok_runs = [r for r in api_runs if r.get("ok")]
    latest_ok = ok_runs[0] if ok_runs else None
    prev_ok = ok_runs[1] if len(ok_runs) > 1 else None
    return {
        "latest_ok_run": latest_ok,
        "previous_ok_run": prev_ok,
        "total_completed_runs": len(ok_runs),
        "latest_run": api_runs[0] if api_runs else None,
    }


# ── /api/training-history ─────────────────────────────────────────────────────
@app.route("/api/training-history", methods=["GET"])
def api_training_history():
    _bootstrap_training_history_if_empty()
    runs = _load_training_history()
    summaries = _training_history_summaries(runs)
    return jsonify({
        "runs": list(reversed(runs)),
        "total": len(runs),
        "path": TRAINING_HISTORY_PATH,
        **summaries,
    })


# ── /api/dashboard-metrics ─────────────────────────────────────────────────────
@app.route("/api/dashboard-metrics", methods=["GET"])
def api_dashboard_metrics():
    """
    Consolidated LSTM metrics for the admin dashboard — sourced from the latest
    successful training history run (same values as meta.json / predictions API).
    """
    _bootstrap_training_history_if_empty()
    runs = _load_training_history()
    summaries = _training_history_summaries(runs)
    latest = summaries.get("latest_ok_run")
    meta = _read_model_meta()

    # A run started from the command line (`cd model && py -3.13 train.py`) writes meta.json and
    # the model files but never reaches training_history.json, which only the web trigger appends
    # to. Reading history first would then describe a model that is no longer on disk — old MAE
    # beside new metrics. meta.json is what predict.py actually loads, so when it is newer than
    # the newest recorded run it becomes the source of truth and history is used only for trends.
    prev_override = None
    if _meta_is_newer_than_run(meta, latest):
        # meta.json becomes "latest", so the run it superseded — the newest one in the log — is
        # what the trend arrows must compare against. Using previous_ok_run here would skip a
        # generation and compare the new model against the one before last.
        prev_override = latest
        latest = _run_from_meta(meta, latest)

    def _f(x):
        try:
            return float(x) if x is not None else None
        except (TypeError, ValueError):
            return None

    mae = _f(latest.get("mae_peso") if latest else None) or _f(meta.get("mae_peso"))
    rmse = _f(latest.get("rmse_peso") if latest else None) or _f(meta.get("rmse_peso"))
    acc = _f(latest.get("avg_accuracy_pct") if latest else None) or _f(
        latest.get("accuracy_pct") if latest else None
    ) or _f(meta.get("avg_accuracy_pct")) or _f(meta.get("accuracy_pct"))

    targets_meta = {}
    if latest and isinstance(latest.get("targets_meta"), dict):
        targets_meta = latest["targets_meta"]
    elif isinstance(meta.get("targets"), dict):
        targets_meta = meta["targets"]

    def _f_list(x):
        """Per-horizon arrays (index 0 = day 1) — dropped entirely if malformed."""
        if not isinstance(x, (list, tuple)):
            return None
        out = [_f(v) for v in x]
        return out if out and all(v is not None for v in out) else None

    by_target = {}
    for key, tm in targets_meta.items():
        if not isinstance(tm, dict):
            continue
        by_target[key] = {
            "mae_peso": _f(tm.get("mae_peso")),
            "rmse_peso": _f(tm.get("rmse_peso")),
            "accuracy_pct": _f(tm.get("accuracy_pct")),
            # Day-1/2/3 breakdown: `accuracy_pct` above is pooled across the whole
            # horizon, so on its own it makes every forecast day look equally
            # reliable. Day 3 is measurably harder than day 1 and the UI should
            # be able to say so.
            "per_horizon_accuracy_pct": _f_list(tm.get("per_horizon_accuracy_pct")),
            "per_horizon_mae_peso": _f_list(tm.get("per_horizon_mae_peso")),
            "baseline_mae_peso": _f(tm.get("baseline_mae_peso")),
            # Honest per-day figure for the predictions table: % of that day's forecasts that
            # landed within P1.00. `per_horizon_accuracy_pct` above is the legacy formula.
            "hit_rate_1p_pct": _f_list((tm.get("hit_rate_pct") or {}).get("1.00")),
            # Same measure at P0.50 — the band the public Price Summary shows per rice type and day,
            # so the admin tables can show the identical figure instead of a different threshold.
            "hit_rate_050_pct": _f_list((tm.get("hit_rate_pct") or {}).get("0.50")),
            "skill_vs_baseline_pct": _f(tm.get("skill_vs_baseline_pct")),
        }

    prev = prev_override or summaries.get("previous_ok_run")

    def _avg_baseline_mae(run):
        """Mean naive-persistence MAE across a run's targets.

        The naive baseline ("tomorrow = today") has no trainable parameters, so it
        cannot improve or degrade on its own. When it moves between two runs, the
        test window itself got easier or harder — which is what lets the dashboard
        tell a real model regression apart from a change in the underlying data.
        """
        tms = (run or {}).get("targets_meta")
        if not isinstance(tms, dict):
            return None
        vals = [
            _f(t.get("baseline_mae_peso"))
            for t in tms.values()
            if isinstance(t, dict) and t.get("baseline_mae_peso") is not None
        ]
        vals = [v for v in vals if v is not None]
        return round(sum(vals) / len(vals), 4) if vals else None

    baseline_now = _avg_baseline_mae(latest)
    baseline_prev = _avg_baseline_mae(prev)

    def _avg_target_mae(run):
        """Mean MAE across a run's rice types. The top-level `mae_peso` is the primary type's only,
        which made the dashboard pair one type's error with the all-type hit rate beside it."""
        tms = (run or {}).get("targets_meta")
        if not isinstance(tms, dict):
            return None
        vals = [_f(t.get("mae_peso")) for t in tms.values() if isinstance(t, dict)]
        vals = [v for v in vals if v is not None]
        return round(sum(vals) / len(vals), 4) if vals else None

    def _hit1(run):
        """Day-1 share of forecasts within P1.00, averaged over rice types (None for pre-v4 runs)."""
        hr = ((run or {}).get("hit_rate_pct") or {}).get("1.00")
        return _f(hr[0]) if isinstance(hr, list) and hr else None

    mae_all_now = _avg_target_mae(latest) if latest else _avg_target_mae({"targets_meta": targets_meta})
    mae_all_prev = _avg_target_mae(prev)
    hit1_now, hit1_prev = _hit1(latest) or _hit1(meta), _hit1(prev)

    return jsonify({
        "ready": bool(latest or meta.get("mae_peso") is not None),
        "source": "training_history" if latest else ("meta.json" if meta else "none"),
        "latest_ok_run": latest,
        "previous_ok_run": prev,
        "metrics": {
            "mae_peso": mae,
            "mae_peso_all_types": mae_all_now,
            "rmse_peso": rmse,
            "accuracy_pct": _f(latest.get("accuracy_pct") if latest else None) or _f(
                meta.get("accuracy_pct")
            ),
            "avg_accuracy_pct": acc,
            "by_target": by_target,
            "baseline_mae_peso": baseline_now,
            # Honest headline metrics — see model/train.py::_hit_rate_pct for why the legacy
            # `accuracy_pct` above must not be reported.
            "hit_rate_pct": (latest or {}).get("hit_rate_pct") or meta.get("hit_rate_pct"),
            "skill_vs_baseline_pct": (
                (latest or {}).get("skill_vs_baseline_pct")
                if (latest or {}).get("skill_vs_baseline_pct") is not None
                else meta.get("skill_vs_baseline_pct")
            ),
            "movement_ratio": (
                (latest or {}).get("movement_ratio")
                if (latest or {}).get("movement_ratio") is not None
                else meta.get("movement_ratio")
            ),
        },
        "quality": {
            "seed": (latest or {}).get("seed") or meta.get("seed"),
            "split_policy": (latest or {}).get("split_policy") or meta.get("split_policy"),
            "split_dates": (latest or {}).get("split_dates") or meta.get("split_dates"),
            "flat_pct_by_split": (
                (latest or {}).get("flat_pct_by_split") or meta.get("flat_pct_by_split")
            ),
            "adf_pvalue": meta.get("adf_pvalue"),
        },
        "trends": {
            "baseline_mae_peso": baseline_now,
            "baseline_mae_peso_prev": baseline_prev,
            "baseline_mae_peso_delta": (
                (baseline_now - baseline_prev)
                if baseline_now is not None and baseline_prev is not None
                else None
            ),
            "mae_peso_delta": (
                (mae - _f(prev.get("mae_peso")))
                if mae is not None and prev and prev.get("mae_peso") is not None
                else None
            ),
            "rmse_peso_delta": (
                (rmse - _f(prev.get("rmse_peso")))
                if rmse is not None and prev and prev.get("rmse_peso") is not None
                else None
            ),
            "accuracy_pct_delta": (
                (acc - (_f(prev.get("avg_accuracy_pct")) or _f(prev.get("accuracy_pct"))))
                if acc is not None and prev
                else None
            ),
            # Change in the figure the dashboard actually shows (day-1 hit rate within P1.00), in
            # percentage points. `accuracy_pct_delta` above is the legacy formula's change and was
            # being printed under the hit rate.
            "hit_rate_1p_delta": (
                round(hit1_now - hit1_prev, 2) if hit1_now is not None and hit1_prev is not None else None
            ),
            "mae_all_types_delta": (
                round(mae_all_now - mae_all_prev, 4) if mae_all_now is not None and mae_all_prev is not None else None
            ),
        },
        "model": {
            "backend": (latest or meta or {}).get("backend"),
            "last_trained": (latest or {}).get("completed_at") or meta.get("last_date"),
            "run_id": (latest or {}).get("id"),
            "train_samples": (latest or meta or {}).get("train_samples"),
            "test_samples": (latest or meta or {}).get("test_samples"),
            "trained_types": (latest or meta or {}).get("trained_types")
            or list(targets_meta.keys()),
        },
        "notes": {
            "accuracy_definition": (
                "hit_rate_pct: share of held-out test forecasts that landed within P0.50/1.00/1.50/2.00 "
                "of the real DA price, per forecast day. accuracy_pct is the legacy 100% − MAE ÷ mean "
                "price formula (98–99% for any model, naive included) — kept for old runs, not displayed."
            ),
            "final_mae_in_logs": (
                "Epoch log MAE is on the normalized scale; PHP/kg values are mae_peso / rmse_peso."
            ),
        },
    })


# ── /api/training-status ─────────────────────────────────────────────────────
@app.route("/api/training-status", methods=["GET"])
def api_training_status():
    _bootstrap_training_history_if_empty()
    with _train_log_lock:
        logs = list(_train_log_buffer)
    runs = _load_training_history()

    # `_last_train_ts`/`_last_saved_run` are process-local, so after a server restart the admin
    # Training page showed "Last Run: — Never" even with a full run history on disk. Fall back to
    # the newest completed run recorded in that history.
    last_run_ts = _last_train_ts.isoformat() if _last_train_ts else None
    last_saved_run = _last_saved_run
    last_result = _last_train_result
    if last_run_ts is None or last_saved_run is None or last_result is None:
        newest = None
        for run in runs:
            completed = run.get("completed_at")
            if not completed:
                continue
            if newest is None or completed > newest.get("completed_at", ""):
                newest = run
        if newest is not None:
            if last_run_ts is None:
                last_run_ts = newest.get("completed_at")
            if last_saved_run is None:
                last_saved_run = newest
            if last_result is None:
                # Without this the admin page read `ok` off a null result and rendered a
                # successful run as "Failed" after any server restart.
                last_result = {
                    "ok": bool(newest.get("ok")),
                    "cancelled": bool(newest.get("cancelled")),
                    "duration": newest.get("duration"),
                    "run_id": newest.get("id"),
                }

    return jsonify({
        "running":      _train_running,
        "logs":         logs,
        "last_run":     last_run_ts,
        "last_result":  last_result,
        "last_saved_run": last_saved_run,
        "history":      {"runs": list(reversed(runs)), "total": len(runs)},
    })


# ── /api/run-training ─────────────────────────────────────────────────────────
@app.route("/api/run-training", methods=["POST"])
def api_run_training():
    global _train_running, _train_cancel_requested
    ok, resp = _require_super_admin()
    if not ok:
        return resp
    with _train_lock:
        if _train_running:
            return jsonify({"success": False, "message": "Training already running."}), 409
        _train_running = True
        _train_cancel_requested = False
    _clear_train_logs()
    threading.Thread(target=_training_worker, daemon=True).start()
    return jsonify({"success": True, "message": "Training started."})


# ── /api/cancel-training ───────────────────────────────────────────────────────
@app.route("/api/cancel-training", methods=["POST"])
def api_cancel_training():
    global _train_cancel_requested, _train_process
    ok, resp = _require_super_admin()
    if not ok:
        return resp
    with _train_lock:
        if not _train_running:
            return jsonify({"success": False, "message": "No training in progress."}), 409
        _train_cancel_requested = True
        proc = _train_process
    if proc is not None and proc.poll() is None:
        try:
            proc.kill()
        except OSError:
            try:
                proc.terminate()
            except OSError:
                pass
    _add_train_log("WARN", "Cancel requested — stopping training subprocess…")
    return jsonify({"success": True, "message": "Training cancel requested."})


# ── /api/stream-training (SSE) ────────────────────────────────────────────────
@app.route("/api/stream-training", methods=["GET"])
def api_stream_training():
    ok, resp = _require_admin()
    if not ok:
        return resp
    q: queue.Queue = queue.Queue(maxsize=500)
    with _train_sse_lock:
        _train_sse_queues.append(q)

    def generate():
        try:
            with _train_log_lock:
                for entry in _train_log_buffer:
                    yield f"data: {json.dumps(entry)}\n\n"
            while True:
                try:
                    data = q.get(timeout=25)
                    yield f"data: {data}\n\n"
                except queue.Empty:
                    yield ": heartbeat\n\n"
        except GeneratorExit:
            pass
        finally:
            with _train_sse_lock:
                if q in _train_sse_queues:
                    _train_sse_queues.remove(q)

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── /api/model-status ─────────────────────────────────────────────────────────
@app.route("/api/model-status", methods=["GET"])
def api_model_status():
    meta_path = os.path.join(MODEL_DIR, "meta.json")
    meta = {}
    if os.path.exists(meta_path):
        try:
            with open(meta_path, encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            pass
    has_model = (
        os.path.exists(os.path.join(MODEL_DIR, "lstm_model.keras"))
        or os.path.exists(os.path.join(MODEL_DIR, "rice_mlp.joblib"))
    )
    return jsonify({
        "ready": has_model and os.path.exists(os.path.join(MODEL_DIR, "scaler.joblib")),
        "has_model": has_model,
        "db_path": DB_PATH,
        "db_exists": os.path.exists(DB_PATH),
        "meta": meta,
    })


# ── Rice catalog: DTI categories/brands, price brackets, taxes, consumer price ──
@app.route("/api/catalog", methods=["GET"])
def api_catalog():
    try:
        from catalog_service import list_catalog
        include_inactive = request.args.get("include_inactive") in ("1", "true", "yes")
        return jsonify(list_catalog(include_inactive=include_inactive))
    except Exception as exc:
        return jsonify({"ready": False, "error": str(exc), "categories": []}), 500


@app.route("/api/taxes", methods=["GET"])
def api_taxes():
    try:
        from catalog_service import list_taxes
        return jsonify(list_taxes())
    except Exception as exc:
        return jsonify({"ready": False, "error": str(exc), "taxes": []}), 500


@app.route("/api/prices/brackets", methods=["GET"])
def api_price_brackets():
    try:
        from catalog_service import list_brackets
        return jsonify(list_brackets(
            category_key=request.args.get("category"),
            market=request.args.get("market"),
            date=request.args.get("date"),
        ))
    except Exception as exc:
        return jsonify({"ready": False, "error": str(exc), "brackets": []}), 500


@app.route("/api/consumer-price", methods=["GET"])
def api_consumer_price():
    key = request.args.get("category")
    if not key:
        return jsonify({"ready": True, "error": "category query param required"}), 400
    try:
        from catalog_service import consumer_price
        return jsonify(consumer_price(key, request.args.get("date")))
    except Exception as exc:
        return jsonify({"ready": False, "error": str(exc)}), 500


# ── Rice Brand module Phase 2: per-brand variance weight ("patong") ──────────────
# Public-safe read: each brand's price = base category price × (1 + weight_pct/100), falling
# back to the plain category price when a brand has no canvassed weight yet. No category param
# returns all 8 categories at once (mirrors /api/catalog's shape).
@app.route("/api/brand-prices", methods=["GET"])
def api_brand_prices():
    try:
        from catalog_service import brand_price, list_catalog
        key = request.args.get("category")
        include_inactive = request.args.get("include_inactive") in ("1", "true", "yes")
        if key:
            return jsonify(brand_price(key, include_inactive=include_inactive))
        cats = list_catalog(include_inactive=include_inactive)
        if not cats.get("ready"):
            return jsonify({"ready": False, "categories": [], "note": cats.get("note", "")})
        return jsonify({"ready": True, "categories": [
            brand_price(c["canonical_key"], include_inactive=include_inactive)
            for c in cats.get("categories", [])
        ]})
    except Exception as exc:
        return jsonify({"ready": False, "error": str(exc), "categories": [], "brands": []}), 500


@app.route("/api/brand-prices/<int:brand_id>/weight", methods=["POST"])
def api_brand_weight_set(brand_id):
    """Admin: set (or clear, with weight_pct omitted/null) one brand's canvassed variance weight."""
    ok, resp = _require_admin()
    if not ok:
        return resp
    payload = request.get_json(silent=True) or {}
    try:
        from catalog_service import set_brand_weight
        result = set_brand_weight(
            brand_id=brand_id,
            weight_pct=payload.get("weight_pct"),
            sample_date=(payload.get("sample_date") or "").strip() or None,
            sample_locations=(payload.get("sample_locations") or "").strip() or None,
            sample_n=payload.get("sample_n"),
            source_notes=(payload.get("source_notes") or "").strip() or None,
            actor=_admin_client_key(),
        )
        return jsonify(result), (200 if result.get("ok") else 400)
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.route("/api/brand-prices/weight-audit", methods=["GET"])
def api_brand_weight_audit():
    """Admin: audit trail of who changed a brand's weight, when, and to what."""
    ok, resp = _require_admin()
    if not ok:
        return resp
    try:
        from catalog_service import list_brand_weight_audit
        brand_id = request.args.get("brand_id")
        return jsonify(list_brand_weight_audit(int(brand_id) if brand_id else None))
    except Exception as exc:
        return jsonify({"ready": False, "error": str(exc), "audit": []}), 500


# ── Rice Brand module Phase 3: full CRUD + governance ────────────────────────────
# add_brand/update_brand/deactivate_brand are the only ways the brand catalog record changes;
# every one of them is admin-only and writes a brand_audit row (see /api/brands/<id>/audit).
def _brand_payload_kwargs(payload: dict) -> dict:
    """Shared arg-extraction for add/update — only keys the caller actually sent are included,
    so update_brand()'s "only change what's passed" semantics work from the same payload shape."""
    kwargs = {}
    for key in ("category_key", "brand_name", "package", "location", "source", "source_url",
                "last_verified", "classification_note", "notes", "verification_status"):
        if key in payload:
            v = payload.get(key)
            kwargs[key] = v.strip() if isinstance(v, str) else v
    return kwargs


@app.route("/api/brands", methods=["POST"])
def api_brand_add():
    """Admin: add a new brand. Requires brand_name, category_key, source; blocks an exact
    (category, brand_name, package) duplicate."""
    ok, resp = _require_admin()
    if not ok:
        return resp
    payload = request.get_json(silent=True) or {}
    try:
        from catalog_service import add_brand
        kwargs = _brand_payload_kwargs(payload)
        kwargs.setdefault("verification_status", "unverified")
        result = add_brand(actor=_admin_client_key(), **kwargs)
        return jsonify(result), (200 if result.get("ok") else 400)
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.route("/api/brands/<int:brand_id>", methods=["PUT"])
def api_brand_update(brand_id):
    """Admin: edit an existing brand's fields and/or verification status. Only fields present in
    the JSON body are changed; the same required-fields/no-duplicate rules apply as on add."""
    ok, resp = _require_admin()
    if not ok:
        return resp
    payload = request.get_json(silent=True) or {}
    try:
        from catalog_service import update_brand
        kwargs = _brand_payload_kwargs(payload)
        result = update_brand(brand_id, actor=_admin_client_key(), **kwargs)
        return jsonify(result), (200 if result.get("ok") else 400)
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.route("/api/brands/<int:brand_id>", methods=["DELETE"])
def api_brand_deactivate(brand_id):
    """Admin: soft-delete a brand (active=0). History (weights, audit) is kept."""
    ok, resp = _require_admin()
    if not ok:
        return resp
    try:
        from catalog_service import deactivate_brand
        result = deactivate_brand(brand_id, active=False, actor=_admin_client_key())
        return jsonify(result), (200 if result.get("ok") else 400)
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.route("/api/brands/<int:brand_id>/reactivate", methods=["POST"])
def api_brand_reactivate(brand_id):
    """Admin: restore a previously deactivated brand."""
    ok, resp = _require_admin()
    if not ok:
        return resp
    try:
        from catalog_service import deactivate_brand
        result = deactivate_brand(brand_id, active=True, actor=_admin_client_key())
        return jsonify(result), (200 if result.get("ok") else 400)
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


# ── Rice Brand module — catalog-display image ────────────────────────────────
# Separate from the JSON add/update routes above: a file upload needs multipart/form-data, which
# request.get_json() can't parse. The image itself lives on disk under public/images/rice-brands/
# (reachable at the identical root-relative URL from both admin/*.html and public/*.html, since
# api_app's static route serves the whole public/ folder) — only the resulting path string is
# stored on the brand row, via catalog_service.set_brand_image.
BRAND_IMAGE_DIR = os.path.join(PROJECT_ROOT, "public", "images", "rice-brands")
BRAND_IMAGE_ALLOWED_EXT = {"png", "jpg", "jpeg", "webp"}
BRAND_IMAGE_MAX_BYTES = 4 * 1024 * 1024  # 4MB


def _delete_brand_image_file(rel_path):
    """Best-effort cleanup of an old/orphaned image file. Only ever deletes inside
    BRAND_IMAGE_DIR — rel_path comes from our own DB column, never from raw user input."""
    if not rel_path or not rel_path.startswith("/public/images/rice-brands/"):
        return
    full = os.path.join(PROJECT_ROOT, rel_path.lstrip("/"))
    try:
        if os.path.isfile(full) and os.path.dirname(os.path.abspath(full)) == os.path.abspath(BRAND_IMAGE_DIR):
            os.remove(full)
    except OSError:
        pass


def _looks_like_image(head: bytes, ext: str) -> bool:
    """Check the file's first bytes (its "magic number") match the image type its name claims, so
    a renamed HTML/script file cannot be uploaded and served from /public/images."""
    if ext == "png":
        return head.startswith(b"\x89PNG\r\n\x1a\n")
    if ext in ("jpg", "jpeg"):
        return head.startswith(b"\xff\xd8\xff")
    if ext == "webp":
        return head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    return False


@app.route("/api/brands/<int:brand_id>/image", methods=["POST"])
def api_brand_image_upload(brand_id):
    """Admin: upload (or replace) one brand's catalog-display image."""
    ok, resp = _require_admin()
    if not ok:
        return resp
    file = request.files.get("image")
    if not file or not file.filename:
        return jsonify({"ok": False, "error": "No image file provided."}), 400
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
    if ext not in BRAND_IMAGE_ALLOWED_EXT:
        return jsonify({"ok": False, "error": "Image must be PNG, JPG, or WEBP."}), 400

    file.seek(0, os.SEEK_END)
    size = file.tell()
    file.seek(0)
    if size <= 0:
        return jsonify({"ok": False, "error": "The uploaded file is empty."}), 400
    if size > BRAND_IMAGE_MAX_BYTES:
        return jsonify({"ok": False, "error": "Image must be 4MB or smaller."}), 400
    head = file.read(16)
    file.seek(0)
    if not _looks_like_image(head, ext):
        return jsonify({"ok": False, "error": "That file is not a real PNG, JPG, or WEBP image."}), 400

    try:
        from catalog_service import set_brand_image
        os.makedirs(BRAND_IMAGE_DIR, exist_ok=True)
        filename = secure_filename(f"brand-{brand_id}-{int(time.time() * 1000)}.{ext}")
        file.save(os.path.join(BRAND_IMAGE_DIR, filename))
        rel_path = f"/public/images/rice-brands/{filename}"

        result = set_brand_image(brand_id, rel_path, actor=_admin_client_key())
        if not result.get("ok"):
            _delete_brand_image_file(rel_path)  # brand lookup failed — don't leave an orphan file
            return jsonify(result), 400
        _delete_brand_image_file(result.get("previous_image_path"))  # replaced an older image
        return jsonify(result), 200
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.route("/api/brands/<int:brand_id>/image", methods=["DELETE"])
def api_brand_image_delete(brand_id):
    """Admin: remove a brand's catalog-display image (the brand still shows the placeholder)."""
    ok, resp = _require_admin()
    if not ok:
        return resp
    try:
        from catalog_service import set_brand_image
        result = set_brand_image(brand_id, None, actor=_admin_client_key())
        if result.get("ok"):
            _delete_brand_image_file(result.get("previous_image_path"))
        return jsonify(result), (200 if result.get("ok") else 400)
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.route("/api/brands/<int:brand_id>/audit", methods=["GET"])
def api_brand_audit(brand_id):
    """Admin: per-brand change-history (add/update/verify/deactivate/reactivate)."""
    ok, resp = _require_admin()
    if not ok:
        return resp
    try:
        from catalog_service import list_brand_audit
        return jsonify(list_brand_audit(brand_id))
    except Exception as exc:
        return jsonify({"ready": False, "error": str(exc), "audit": []}), 500


# ── Rice import tariff (quarterly, price-indexed, effective-date table) ──────────
@app.route("/api/tariff", methods=["GET"])
def api_tariff():
    """Current applicable tariff + full dated schedule + FAO helper config."""
    try:
        from catalog_service import tariff_status
        return jsonify(tariff_status(request.args.get("date")))
    except Exception as exc:
        return jsonify({"ready": False, "error": str(exc), "applicable": None, "schedule": []}), 500


@app.route("/api/tariff", methods=["POST"])
def api_tariff_add():
    """Admin: append a confirmed quarterly tariff rate (from a DA certification / BOC CMO)."""
    ok, resp = _require_admin()
    if not ok:
        return resp
    payload = request.get_json(silent=True) or {}
    try:
        from catalog_service import add_tariff_quarter
        result = add_tariff_quarter(
            rate_pct=payload.get("rate_pct"),
            effective_start=(payload.get("effective_start") or "").strip(),
            effective_end=(payload.get("effective_end") or "").strip() or None,
            quarter_label=(payload.get("quarter_label") or "").strip() or None,
            legal_basis=(payload.get("legal_basis") or "").strip() or None,
            da_certification_url=(payload.get("da_certification_url") or "").strip() or None,
            source=(payload.get("source") or "").strip() or None,
            actor=_admin_client_key(),
        )
        return jsonify(result), (200 if result.get("ok") else 400)
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.route("/api/tariff/indicative", methods=["GET"])
def api_tariff_indicative():
    """Read-only FAO indicative-rate calculator (decision aid; DA certification is authoritative)."""
    try:
        from catalog_service import fao_indicative
        cur = request.args.get("current_price")
        base = request.args.get("baseline_price")
        return jsonify(fao_indicative(
            current_price=float(cur) if cur not in (None, "") else None,
            baseline_price=float(base) if base not in (None, "") else None,
        ))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "current_price must be a number."}), 400
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.route("/api/tariff/audit", methods=["GET"])
def api_tariff_audit():
    """Admin: tariff change audit log."""
    ok, resp = _require_admin()
    if not ok:
        return resp
    try:
        from catalog_service import list_tariff_audit
        return jsonify(list_tariff_audit(int(request.args.get("limit", 50))))
    except Exception as exc:
        return jsonify({"ready": False, "error": str(exc), "audit": []}), 500


@app.route("/api/tariff/<int:tid>/status", methods=["POST"])
def api_tariff_status(tid):
    """Admin: activate/deactivate a tariff row. Inactive rows are kept for history but excluded
    from applicable-tariff selection and consumer-price calculations."""
    ok, resp = _require_admin()
    if not ok:
        return resp
    payload = request.get_json(silent=True) or {}
    active = bool(payload.get("active"))
    try:
        from catalog_service import set_tariff_active
        result = set_tariff_active(tid, active, actor=_admin_client_key())
        if result.get("ok") and not result.get("unchanged"):
            verb = "activated" if active else "deactivated"
            _add_log("INFO", f"Tariff #{tid} ({result.get('quarter_label') or '?'}) {verb} "
                             f"by {_admin_client_key()}", source="TARIFF")
        return jsonify(result), (200 if result.get("ok") else 400)
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


# ── System Logs: expose the live in-memory log buffer to the admin dashboard ────
@app.route("/api/logs", methods=["GET"])
def api_logs():
    """Admin: real system activity from the in-memory buffer (newest first). In-memory only —
    resets when the server restarts. Optional ?level= and ?limit= filters."""
    ok, resp = _require_admin()
    if not ok:
        return resp
    with _LOG_LOCK:
        entries = list(_LOG_BUFFER)
    entries.reverse()  # newest first
    level = (request.args.get("level") or "").upper().strip()
    if level and level != "ALL":
        want = "WARN" if level == "WARNING" else level
        entries = [e for e in entries if (e.get("level") or "").upper() == want]
    try:
        limit = int(request.args.get("limit", 0))
        if limit > 0:
            entries = entries[:limit]
    except (TypeError, ValueError):
        pass
    return jsonify({"ready": True, "logs": entries, "count": len(entries),
                    "note": "" if entries else "No system activity recorded yet."})


@app.route("/api/logs/clear", methods=["POST"])
def api_logs_clear():
    """Admin: clear the in-memory system-log buffer."""
    ok, resp = _require_super_admin()
    if not ok:
        return resp
    with _LOG_LOCK:
        _LOG_BUFFER.clear()
    _add_log("INFO", "System logs cleared by admin.", source="AUTH")
    return jsonify({"ok": True})


# ── /api/import-2026 ──────────────────────────────────────────────────────────
@app.route("/api/import-2026", methods=["POST", "GET"])
def api_import_2026():
    """I-import / i-sync ang 2026 XLSX files papunta sa database."""
    ok, resp = _require_admin()
    if not ok:
        return resp
    try:
        from import_2026 import import_all
        result = import_all(verbose=False)
        return jsonify({"success": True, **result})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


# ── /api/predictions ──────────────────────────────────────────────────────────
# The 8 canonical rice keys. Anything else is a client error, not a silent fallback.
VALID_RICE_KEYS = {
    "locSpecial", "locPremium", "locWellMilled", "locRegular",
    "impSpecial", "impPremium", "impWellMilled", "impRegular",
}


@app.route("/api/privacy-status", methods=["GET"])
def api_privacy_status():
    """Machine-readable RA 10173 posture: what personal data is held and how it is protected."""
    try:
        from privacy import privacy_status
        return jsonify({"ready": True, **privacy_status()})
    except Exception as exc:
        return jsonify({"ready": False, "error": str(exc)}), 503


@app.route("/api/predictions", methods=["GET"])
def api_predictions():
    # Previously an unknown/garbage `type` silently returned the default target with HTTP 200,
    # so a client typo — or an injected string — looked like a successful request.
    rice_type = (request.args.get("type") or "").strip()
    if rice_type and rice_type not in VALID_RICE_KEYS:
        return jsonify({
            "ready": False,
            "error": f"Unknown rice type '{rice_type}'.",
            "valid_types": sorted(VALID_RICE_KEYS),
        }), 400
    try:
        from predict import predict as run_predict
        result = run_predict()
        if result.get("error"):
            return jsonify(result), 503
        return jsonify(result)
    except Exception as exc:
        return jsonify({"ready": False, "error": str(exc)}), 503


# ══════════════════════════════════════════════
# PRICE ALERTS
# ══════════════════════════════════════════════

try:
    from alerts_engine import (
        clear_log as alerts_clear_log,
        create_rule as alerts_create_rule,
        delete_rule as alerts_delete_rule,
        evaluate_alerts,
        get_summary as alerts_get_summary,
        list_log as alerts_list_log,
        list_rules as alerts_list_rules,
        toggle_rule as alerts_toggle_rule,
        update_rule as alerts_update_rule,
    )
    _ALERTS_AVAILABLE = True
except ImportError as _alerts_err:
    _ALERTS_AVAILABLE = False
    _ALERTS_IMPORT_ERROR = str(_alerts_err)


@app.route("/api/alerts", methods=["GET"])
def api_alerts():
    """Rules + notification log; optional ?evaluate=1 runs live price checks. Admin only."""
    if not _ALERTS_AVAILABLE:
        return jsonify({"error": _ALERTS_IMPORT_ERROR, "ready": False}), 503
    ok, resp = _require_admin()
    if not ok:
        return resp
    try:
        if request.args.get("evaluate", "").lower() in ("1", "true", "yes"):
            result = evaluate_alerts()
            level_map = {"danger": "ERROR", "warning": "WARN", "info": "INFO", "success": "SUCCESS"}
            for entry in result.get("new_entries", []):
                lvl = level_map.get(entry.get("type"), "INFO")
                _add_log(lvl, f"[ALERT] {entry.get('desc', entry.get('title', ''))}")
            return jsonify({"ready": True, **result})
        return jsonify({
            "ready": True,
            "rules": alerts_list_rules(),
            "log": alerts_list_log(50),
            "summary": alerts_get_summary(),
        })
    except Exception as exc:
        return jsonify({"ready": False, "error": str(exc)}), 500


@app.route("/api/alerts/evaluate", methods=["POST"])
def api_alerts_evaluate():
    if not _ALERTS_AVAILABLE:
        return jsonify({"success": False, "error": _ALERTS_IMPORT_ERROR}), 503
    ok, resp = _require_admin()
    if not ok:
        return resp
    try:
        result = evaluate_alerts()
        level_map = {"danger": "ERROR", "warning": "WARN", "info": "INFO", "success": "SUCCESS"}
        for entry in result.get("new_entries", []):
            lvl = level_map.get(entry.get("type"), "INFO")
            _add_log(lvl, f"[ALERT] {entry.get('desc', entry.get('title', ''))}")
        return jsonify({"success": True, **result})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


@app.route("/api/alerts/summary", methods=["GET"])
def api_alerts_summary():
    if not _ALERTS_AVAILABLE:
        return jsonify({"ready": False, "error": _ALERTS_IMPORT_ERROR}), 503
    try:
        return jsonify({"ready": True, **alerts_get_summary()})
    except Exception as exc:
        return jsonify({"ready": False, "error": str(exc)}), 500


@app.route("/api/alerts/rules", methods=["POST"])
def api_alerts_create_rule():
    if not _ALERTS_AVAILABLE:
        return jsonify({"success": False, "error": _ALERTS_IMPORT_ERROR}), 503
    ok, resp = _require_admin()
    if not ok:
        return resp
    payload = request.get_json(silent=True) or {}
    try:
        rule = alerts_create_rule(payload)
        return jsonify({"success": True, "rule": rule})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 400


@app.route("/api/alerts/rules/<rule_id>", methods=["PUT"])
def api_alerts_update_rule(rule_id: str):
    if not _ALERTS_AVAILABLE:
        return jsonify({"success": False, "error": _ALERTS_IMPORT_ERROR}), 503
    ok, resp = _require_admin()
    if not ok:
        return resp
    payload = request.get_json(silent=True) or {}
    try:
        rule = alerts_update_rule(rule_id, payload)
        if not rule:
            return jsonify({"success": False, "error": "Rule not found"}), 404
        return jsonify({"success": True, "rule": rule})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 400


@app.route("/api/alerts/rules/<rule_id>", methods=["DELETE"])
def api_alerts_delete_rule(rule_id: str):
    if not _ALERTS_AVAILABLE:
        return jsonify({"success": False, "error": _ALERTS_IMPORT_ERROR}), 503
    ok_admin, resp = _require_admin()
    if not ok_admin:
        return resp
    ok = alerts_delete_rule(rule_id)
    if not ok:
        return jsonify({"success": False, "error": "Rule not found"}), 404
    return jsonify({"success": True})


@app.route("/api/alerts/rules/<rule_id>/toggle", methods=["POST"])
def api_alerts_toggle_rule(rule_id: str):
    if not _ALERTS_AVAILABLE:
        return jsonify({"success": False, "error": _ALERTS_IMPORT_ERROR}), 503
    ok, resp = _require_admin()
    if not ok:
        return resp
    payload = request.get_json(silent=True) or {}
    active = payload.get("active") if "active" in payload else None
    rule = alerts_toggle_rule(rule_id, active)
    if not rule:
        return jsonify({"success": False, "error": "Rule not found"}), 404
    return jsonify({"success": True, "rule": rule})


@app.route("/api/alerts/log", methods=["GET"])
def api_alerts_log():
    if not _ALERTS_AVAILABLE:
        return jsonify({"ready": False, "error": _ALERTS_IMPORT_ERROR}), 503
    ok, resp = _require_admin()
    if not ok:
        return resp
    return jsonify({"ready": True, "log": alerts_list_log(100)})


@app.route("/api/alerts/log", methods=["DELETE"])
def api_alerts_clear_log():
    if not _ALERTS_AVAILABLE:
        return jsonify({"success": False, "error": _ALERTS_IMPORT_ERROR}), 503
    ok, resp = _require_admin()
    if not ok:
        return resp
    alerts_clear_log()
    return jsonify({"success": True})


# ══════════════════════════════════════════════
# SYSTEM SETTINGS
# ══════════════════════════════════════════════

try:
    from settings_store import change_password, get_settings, reset_to_defaults, update_settings
    _SETTINGS_AVAILABLE = True
except ImportError as _settings_err:
    _SETTINGS_AVAILABLE = False
    _SETTINGS_IMPORT_ERROR = str(_settings_err)


@app.route("/api/settings", methods=["GET"])
def api_get_settings():
    """Full settings for a signed-in admin. Anyone else gets only the display options (system
    name, currency, date format): this used to return the admin's username, email, phone, bio,
    photo, the alert email and the server file path to anyone who asked."""
    if not _SETTINGS_AVAILABLE:
        return jsonify({"ready": False, "error": _SETTINGS_IMPORT_ERROR}), 503
    try:
        data = get_settings()
        data.pop("path", None)
        if _ADMIN_AUTH_AVAILABLE and not session_identity(_admin_token_from_request()):
            general = (data.get("settings") or {}).get("general") or {}
            data = {"settings": {"general": {k: general.get(k) for k in ("system_name", "currency", "date_format")}},
                    "public": True}
        return jsonify({"ready": True, **data})
    except Exception as exc:
        return jsonify({"ready": False, "error": str(exc)}), 500


@app.route("/api/settings", methods=["PUT"])
def api_put_settings():
    if not _SETTINGS_AVAILABLE:
        return jsonify({"success": False, "error": _SETTINGS_IMPORT_ERROR}), 503
    ok, resp = _require_super_admin()
    if not ok:
        return resp
    payload = request.get_json(silent=True) or {}
    try:
        result = update_settings(payload)
        return jsonify({"success": True, **result})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 400


@app.route("/api/settings/reset", methods=["POST"])
def api_reset_settings():
    if not _SETTINGS_AVAILABLE:
        return jsonify({"success": False, "error": _SETTINGS_IMPORT_ERROR}), 503
    ok, resp = _require_super_admin()
    if not ok:
        return resp
    try:
        result = reset_to_defaults()
        return jsonify({"success": True, **result})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


try:
    from admin_auth import (
        DEACTIVATED_ADMIN_MSG,
        check_lockout,
        clear_failures,
        create_session,
        record_failure,
        authenticate_admin,
        change_primary_credentials,
        revoke_session,
        session_identity,
        validate_session,
        verify_admin_password,
        verify_admin_pin,
    )
    _ADMIN_AUTH_AVAILABLE = True
except ImportError as _admin_auth_err:
    _ADMIN_AUTH_AVAILABLE = False
    _ADMIN_AUTH_IMPORT_ERROR = str(_admin_auth_err)


# Rate limits are keyed on the caller's address. X-Forwarded-For is set by the CLIENT unless a
# reverse proxy overwrites it, so trusting it let anyone send a fresh fake address per request and
# never hit a lockout. It is only honoured when AGRIPRICE_TRUST_PROXY=1 (deployed behind a proxy).
_TRUST_PROXY = os.environ.get("AGRIPRICE_TRUST_PROXY", "").strip().lower() in ("1", "true", "yes")


def _admin_client_key():
    if _TRUST_PROXY and request.headers.get("X-Forwarded-For"):
        return request.headers["X-Forwarded-For"].split(",")[0].strip()
    return request.remote_addr or "unknown"


def _account_key(name: str) -> str:
    """Second lockout key per account, so changing address does not reset the count for it."""
    return "acct:" + str(name or "").strip().lower()


def _admin_token_from_request():
    auth = request.headers.get("Authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    # Never from the URL (?token=): URLs end up in browser history, logs and Referer headers.
    return (request.headers.get("X-Admin-Token") or "").strip()


MUST_CHANGE_MSG = "Change the default admin password and PIN first."


def _must_change_response():
    return jsonify({"ok": False, "success": False, "error": MUST_CHANGE_MSG, "code": "must_change_credentials"}), 403


def _require_admin():
    """Guard for admin endpoints. Returns (ok, error_response). When admin auth is wired,
    a valid server-side session token is required; if the auth module is unavailable (dev), allow.
    A built-in admin still signed in with the default password/PIN is refused until they change it."""
    if not _ADMIN_AUTH_AVAILABLE:
        return True, None
    me = session_identity(_admin_token_from_request())
    if not me:
        return False, (jsonify({"ok": False, "error": "Admin session required."}), 401)
    if me.get("must_change_credentials"):
        return False, _must_change_response()
    return True, None


SUPER_ADMIN_ONLY_MSG = "Only a Super Admin can do this. Ask a Super Admin to make this change."


def _require_super_admin():
    """Guard for Super-Admin-only actions: User Management, Settings changes, model training,
    clearing logs and deleting report files. A plain Admin keeps every read-only view plus the
    day-to-day actions (scraper runs, alerts, reports). Same return shape as _require_admin."""
    if not _ADMIN_AUTH_AVAILABLE:
        return True, None
    me = session_identity(_admin_token_from_request())
    if not me:
        return False, (jsonify({"ok": False, "success": False, "error": "Admin session required."}), 401)
    if me.get("must_change_credentials"):
        return False, _must_change_response()
    if me.get("role") != "super_admin":
        return False, (jsonify({"ok": False, "success": False, "error": SUPER_ADMIN_ONLY_MSG,
                                "code": "super_admin_only"}), 403)
    return True, None


@app.route("/api/admin/verify-password", methods=["POST"])
def api_admin_verify_password():
    """Verify admin username/password only (step 1 before access code)."""
    if not _ADMIN_AUTH_AVAILABLE:
        return jsonify({"success": False, "error": _ADMIN_AUTH_IMPORT_ERROR}), 503
    client_key = _admin_client_key()
    payload = request.get_json(silent=True) or {}
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""
    for key in (client_key, _account_key(username)):
        ok_lock, lock_msg = check_lockout(key)
        if not ok_lock:
            return jsonify({"success": False, "error": lock_msg}), 429

    try:
        valid, err = verify_admin_password(username, password)
        if not valid and err == DEACTIVATED_ADMIN_MSG:
            _add_log("WARN", f"Sign-in refused for deactivated admin '{username}' from {client_key}", source="AUTH")
            return jsonify({"success": False, "error": err, "code": "deactivated"}), 403
        if not valid:
            record_failure(client_key)
            record_failure(_account_key(username))
            return jsonify({"success": False, "error": err or "Invalid sign-in details."}), 401
        # Deliberately NOT clearing the failure count here: only a full sign-in (password + PIN)
        # does. Clearing on the password step let someone who knew the password guess the PIN
        # forever, since every correct password reset the counter.
        return jsonify({"success": True})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


@app.route("/api/admin/verify", methods=["POST"])
def api_admin_verify():
    """Verify admin credentials; return short-lived session token."""
    if not _ADMIN_AUTH_AVAILABLE:
        return jsonify({"success": False, "error": _ADMIN_AUTH_IMPORT_ERROR}), 503
    client_key = _admin_client_key()
    payload = request.get_json(silent=True) or {}
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""
    access_code = "".join(ch for ch in str(payload.get("access_code", "")) if ch.isdigit())
    for key in (client_key, _account_key(username)):
        ok_lock, lock_msg = check_lockout(key)
        if not ok_lock:
            _add_log("WARN", f"Admin login blocked (locked out) for '{username or '?'}' from {client_key}", source="AUTH")
            return jsonify({"success": False, "error": lock_msg}), 429

    try:
        valid, err, identity = authenticate_admin(username, password, access_code)
        if not valid and err == DEACTIVATED_ADMIN_MSG:
            return jsonify({"success": False, "error": err, "code": "deactivated"}), 403
        if not valid:
            record_failure(client_key)
            record_failure(_account_key(username))
            _add_log("WARN", f"Failed admin login for '{username or '?'}' from {client_key}", source="AUTH")
            return jsonify({"success": False, "error": err or "Invalid sign-in details."}), 401
        clear_failures(client_key)
        clear_failures(_account_key(username))
        token, ttl_sec = create_session(client_key, identity)
        _add_log("INFO", f"Admin '{username}' signed in from {client_key}", source="AUTH")
        return jsonify({
            "success": True,
            "token": token,
            "expires_in": ttl_sec,
            "admin": {k: identity.get(k) for k in ("kind", "username", "name", "role", "avatar", "must_change_credentials")} if identity else None,
        })
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


@app.route("/api/admin/session", methods=["GET"])
def api_admin_session():
    if not _ADMIN_AUTH_AVAILABLE:
        return jsonify({"valid": False, "error": _ADMIN_AUTH_IMPORT_ERROR}), 503
    token = _admin_token_from_request()
    identity = session_identity(token)
    if identity:
        return jsonify({"valid": True, "admin": identity})
    return jsonify({"valid": False}), 401


@app.route("/api/admin/me/credentials", methods=["POST"])
def api_admin_me_credentials():
    """The built-in admin replaces their password and/or PIN (required while the defaults are in
    use). Needs the current password; works even while other admin actions are blocked."""
    if not _ADMIN_AUTH_AVAILABLE:
        return jsonify({"success": False, "error": _ADMIN_AUTH_IMPORT_ERROR}), 503
    token = _admin_token_from_request()
    me = session_identity(token)
    if not me:
        return jsonify({"success": False, "error": "Admin session required."}), 401
    if me.get("kind") != "primary":
        return jsonify({"success": False, "error": "Ask a Super Admin to change your password or PIN in User Management."}), 403
    client_key = _admin_client_key()
    ok_lock, lock_msg = check_lockout(client_key)
    if not ok_lock:
        return jsonify({"success": False, "error": lock_msg}), 429
    payload = request.get_json(silent=True) or {}
    ok, msg = change_primary_credentials(
        payload.get("current_password") or "",
        new_password=payload.get("new_password") or None,
        new_code=payload.get("new_pin") or None,
    )
    if not ok:
        if msg == "Current password is incorrect.":
            record_failure(client_key)
        return jsonify({"success": False, "error": msg}), 400
    _add_log("WARN", f"Admin '{me.get('username')}' changed their sign-in credentials", source="AUTH")
    return jsonify({"success": True, "message": msg, "admin": session_identity(token)})


@app.route("/api/admin/logout", methods=["POST"])
def api_admin_logout():
    if not _ADMIN_AUTH_AVAILABLE:
        return jsonify({"success": False}), 503
    revoke_session(_admin_token_from_request())
    _add_log("INFO", f"Admin signed out from {_admin_client_key()}", source="AUTH")
    return jsonify({"success": True})


@app.route("/api/settings/password", methods=["POST"])
def api_change_password():
    if not _SETTINGS_AVAILABLE:
        return jsonify({"success": False, "error": _SETTINGS_IMPORT_ERROR}), 503
    ok_admin, resp = _require_super_admin()
    if not ok_admin:
        return resp
    payload = request.get_json(silent=True) or {}
    current = payload.get("current", "")
    new_pw = payload.get("new", "")
    ok, msg = change_password(current, new_pw)
    if not ok:
        return jsonify({"success": False, "error": msg}), 400
    return jsonify({"success": True, "message": msg})


# ══════════════════════════════════════════════
# PUBLIC / VENDOR USER ACCOUNTS (server-side — see model/user_auth.py)
# ══════════════════════════════════════════════

try:
    # Aliased — user_auth's check_lockout/clear_failures/record_failure take a
    # (bucket, client_key) pair, not admin_auth's single client_key (imported
    # above, same names). Importing them under the bare names here would
    # silently rebind the module-global name Python resolves at CALL time —
    # which broke every admin-auth call site (they'd suddenly be invoked with
    # the wrong arity and 500, since admin_auth's own call sites only pass
    # one argument) even though admin_auth's functions were imported first.
    from user_auth import (
        CHANGE_PASSWORD_ATTEMPTS,
        DEACTIVATED_MSG as USER_DEACTIVATED_MSG,
        LOGIN_ATTEMPTS,
        REMEMBER_TTL_SECONDS,
        RESET_REQUEST_ATTEMPTS,
        RESET_VERIFY_ATTEMPTS,
        SESSION_TTL_SECONDS,
        WRONG_CURRENT_PASSWORD_MSG,
        change_password_for_user,
        check_lockout as user_check_lockout,
        clear_failures as user_clear_failures,
        login_user,
        record_failure as user_record_failure,
        request_reset,
        reset_password_with_ticket,
        signup_user,
        verify_reset_code,
    )
    from user_store import (
        add_activity as user_add_activity,
        create_user_session,
        get_session_user,
        get_user_by_email as user_get_by_email,
        list_activity as user_list_activity,
        mark_user_welcomed,
        revoke_user_session,
        revoke_user_sessions,
        update_profile as user_update_profile,
    )
    from mailer import is_configured as mailer_is_configured
    _USER_AUTH_AVAILABLE = True
except ImportError as _user_auth_err:
    _USER_AUTH_AVAILABLE = False
    _USER_AUTH_IMPORT_ERROR = str(_user_auth_err)


def _public_user(user: dict) -> dict:
    """The account's own profile, as returned to that account only (login, session, profile)."""
    return {
        "name": user["name"], "email": user["email"], "role": user["role"],
        "title": user.get("title") or "", "phone": user.get("phone") or "", "bio": user.get("bio") or "",
        "avatar": user.get("avatar") or "", "extra_info": user.get("extra_info") or [],
        "created_at": user.get("created_at"), "last_login_at": user.get("last_login_at"),
        # True until this account has seen its one-time welcome popup (new accounts only).
        "show_welcome": not user.get("welcome_seen_at"),
        "google_linked": bool(user.get("google_linked")),
    }


def _start_user_session(user: dict, remember: bool) -> dict:
    """Issue the server-side session a retailer's browser must present on account changes.
    Before this, "logged in" was only a note in the browser, and the account endpoints trusted
    whatever email the request named."""
    ttl = REMEMBER_TTL_SECONDS if remember else SESSION_TTL_SECONDS
    token = create_user_session(user["id"], ttl)
    return {"user": _public_user(user), "token": token, "expires_in": ttl, "remember": remember}


def _user_token_from_request() -> str:
    auth = request.headers.get("Authorization") or ""
    return auth[7:].strip() if auth.lower().startswith("bearer ") else ""


def _require_user():
    """(user, None) for a valid retailer session, else (None, 401 response)."""
    user = get_session_user(_user_token_from_request())
    if not user:
        return None, (jsonify({
            "success": False, "code": "session_expired",
            "error": "Your session has expired. Please log in again.",
        }), 401)
    return user, None


@app.route("/api/auth/signup", methods=["POST"])
def api_auth_signup():
    if not _USER_AUTH_AVAILABLE:
        return jsonify({"success": False, "error": _USER_AUTH_IMPORT_ERROR}), 503
    payload = request.get_json(silent=True) or {}
    try:
        ok, msg = signup_user(payload.get("name"), payload.get("email"), payload.get("password"))
        if not ok:
            return jsonify({"success": False, "error": msg}), 400
        user = user_get_by_email(payload.get("email"))
        user_add_activity(user["id"], "INFO", "Account created")
        return jsonify({"success": True, **_start_user_session(user, remember=False)})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


@app.route("/api/auth/login", methods=["POST"])
def api_auth_login():
    if not _USER_AUTH_AVAILABLE:
        return jsonify({"success": False, "error": _USER_AUTH_IMPORT_ERROR}), 503
    client_key = _admin_client_key()
    payload = request.get_json(silent=True) or {}
    acct_key = _account_key(payload.get("email"))
    for key in (client_key, acct_key):
        ok_lock, lock_msg = user_check_lockout(LOGIN_ATTEMPTS, key)
        if not ok_lock:
            return jsonify({"success": False, "error": lock_msg}), 429

    try:
        ok, msg, user = login_user(payload.get("email"), payload.get("password"))
        if not ok:
            if msg == USER_DEACTIVATED_MSG:
                # Correct credentials, so not a guessing attempt — don't burn a lockout strike.
                return jsonify({"success": False, "error": msg, "code": "deactivated"}), 403
            user_record_failure(LOGIN_ATTEMPTS, client_key)
            user_record_failure(LOGIN_ATTEMPTS, acct_key)
            # Shown on that account's Recent Activity (no IP is recorded).
            target = user_get_by_email(payload.get("email"))
            if target:
                user_add_activity(target["id"], "WARN", "Failed sign-in attempt (wrong password)")
                if not user_check_lockout(LOGIN_ATTEMPTS, client_key)[0]:
                    user_add_activity(target["id"], "ERROR", "Sign-in locked for 15 minutes after too many failed attempts")
            return jsonify({"success": False, "error": msg}), 401
        user_clear_failures(LOGIN_ATTEMPTS, client_key)
        user_clear_failures(LOGIN_ATTEMPTS, acct_key)
        full = user_get_by_email(user["email"]) or user
        user_add_activity(full["id"], "INFO", "Signed in" + (" (remembered on this device)" if payload.get("remember") else ""))
        return jsonify({"success": True, **_start_user_session(full, remember=bool(payload.get("remember")))})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


try:
    import google_signin as _google
    _GOOGLE_AVAILABLE = True
except ImportError:
    _GOOGLE_AVAILABLE = False


@app.route("/api/auth/config", methods=["GET"])
def api_auth_config():
    """Public sign-in options for the login/sign-up pages. The Google client ID is public by design
    (it is visible in every page that shows the Google button); no secret is ever returned."""
    return jsonify({
        "success": True,
        "google_client_id": _google.client_id() if _GOOGLE_AVAILABLE else "",
    })


@app.route("/api/auth/google", methods=["POST"])
def api_auth_google():
    """Continue with Google: verify the ID token from Google Identity Services, then sign in,
    link (same verified email) or create the public account. Public users only."""
    if not _USER_AUTH_AVAILABLE or not _GOOGLE_AVAILABLE:
        return jsonify({"success": False, "error": "Google sign-in is unavailable on this server."}), 503
    client_key = _admin_client_key()
    ok_lock, lock_msg = user_check_lockout(LOGIN_ATTEMPTS, client_key)
    if not ok_lock:
        return jsonify({"success": False, "error": lock_msg}), 429
    payload = request.get_json(silent=True) or {}
    ok, msg, claims = _google.verify_credential(payload.get("credential"))
    if not ok:
        user_record_failure(LOGIN_ATTEMPTS, client_key)
        return jsonify({"success": False, "error": msg}), 401
    try:
        ok, msg, user, info = _google.sign_in(claims)
    except Exception as exc:
        _add_log("ERROR", f"Google sign-in failed: {exc}", source="AUTH")
        return jsonify({"success": False, "error": "Could not sign you in with Google right now."}), 500
    if not ok:
        return jsonify({"success": False, "error": msg, "code": "deactivated"}), 403
    user_clear_failures(LOGIN_ATTEMPTS, client_key)
    remember = bool(payload.get("remember"))
    if info["created"]:
        user_add_activity(user["id"], "INFO", "Account created with Google")
    elif info["linked"]:
        user_add_activity(user["id"], "WARN", "Google account linked to this account")
    user_add_activity(user["id"], "INFO", "Signed in with Google" + (" (remembered on this device)" if remember else ""))
    return jsonify({"success": True, **_start_user_session(user, remember=remember),
                    "created": info["created"], "linked": info["linked"]})


@app.route("/api/auth/forgot-password", methods=["POST"])
def api_auth_forgot_password():
    """Step 1 of 3. By design (see model/user_auth.py's docstring) this
    reveals whether the email is registered, rather than a generic response —
    an explicit "email verified" vs "no account found" popup, at the user's
    request. "already_sent" (a valid code from a recent request is still
    active) is reported too, instead of silently emailing a second code that
    would invalidate the first one in the visitor's inbox."""
    if not _USER_AUTH_AVAILABLE:
        return jsonify({"success": False, "error": _USER_AUTH_IMPORT_ERROR}), 503
    if not mailer_is_configured():
        return jsonify({"success": False, "error": "Email service is not configured on the server."}), 503
    client_key = _admin_client_key()
    ok_lock, lock_msg = user_check_lockout(RESET_REQUEST_ATTEMPTS, client_key)
    if not ok_lock:
        return jsonify({"success": False, "error": lock_msg}), 429

    payload = request.get_json(silent=True) or {}
    email = (payload.get("email") or "").strip().lower()
    try:
        status, message = request_reset(email)
    except Exception as exc:
        _add_log("ERROR", f"Password reset request failed: {exc}", source="AUTH")
        return jsonify({"success": False, "error": "Could not process that request."}), 500

    _add_log(
        "INFO" if status in ("sent", "already_sent") else "WARN",
        f"Password reset requested for '{email or '?'}' from {client_key} ({status})",
        source="AUTH",
    )
    if status == "not_found":
        # Only "no such account" counts toward the lockout — it's the one
        # response shape that rewards an attacker for probing many emails;
        # legitimate requests (sent/already_sent) shouldn't cost the visitor
        # their remaining attempts.
        user_record_failure(RESET_REQUEST_ATTEMPTS, client_key)
        return jsonify({"success": False, "error": message}), 404
    if status == "deactivated":
        return jsonify({"success": False, "error": message, "code": "deactivated"}), 403
    if status == "mail_error":
        return jsonify({"success": False, "error": "Could not send the code right now. Try again shortly."}), 502
    user_clear_failures(RESET_REQUEST_ATTEMPTS, client_key)
    if status == "sent":
        target = user_get_by_email(email)
        if target:
            user_add_activity(target["id"], "INFO", "Password reset code sent to this email")
    return jsonify({"success": True, "status": status, "message": message})


@app.route("/api/auth/verify-reset-code", methods=["POST"])
def api_auth_verify_reset_code():
    """Step 2 of 3: check the emailed code on its own. Returns a one-time
    'ticket' on success — the client holds onto it and sends it back (not the
    code) to actually change the password in step 3."""
    if not _USER_AUTH_AVAILABLE:
        return jsonify({"success": False, "error": _USER_AUTH_IMPORT_ERROR}), 503
    client_key = _admin_client_key()
    ok_lock, lock_msg = user_check_lockout(RESET_VERIFY_ATTEMPTS, client_key)
    if not ok_lock:
        return jsonify({"success": False, "error": lock_msg}), 429

    payload = request.get_json(silent=True) or {}
    try:
        ok, msg, ticket = verify_reset_code(payload.get("email"), payload.get("code"))
        if not ok:
            user_record_failure(RESET_VERIFY_ATTEMPTS, client_key)
            return jsonify({"success": False, "error": msg}), 400
        user_clear_failures(RESET_VERIFY_ATTEMPTS, client_key)
        return jsonify({"success": True, "message": msg, "ticket": ticket})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


@app.route("/api/auth/reset-password", methods=["POST"])
def api_auth_reset_password():
    """Step 3 of 3: set the new password, gated on the ticket from step 2 (not
    the original code)."""
    if not _USER_AUTH_AVAILABLE:
        return jsonify({"success": False, "error": _USER_AUTH_IMPORT_ERROR}), 503
    client_key = _admin_client_key()
    ok_lock, lock_msg = user_check_lockout(RESET_VERIFY_ATTEMPTS, client_key)
    if not ok_lock:
        return jsonify({"success": False, "error": lock_msg}), 429

    payload = request.get_json(silent=True) or {}
    try:
        ok, msg = reset_password_with_ticket(payload.get("email"), payload.get("ticket"), payload.get("new_password"))
        if not ok:
            user_record_failure(RESET_VERIFY_ATTEMPTS, client_key)
            return jsonify({"success": False, "error": msg}), 400
        user_clear_failures(RESET_VERIFY_ATTEMPTS, client_key)
        target = user_get_by_email(payload.get("email"))
        if target:
            user_add_activity(target["id"], "INFO", "Password reset with an email code (other devices signed out)")
        return jsonify({"success": True, "message": msg})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


@app.route("/api/auth/session", methods=["GET"])
def api_auth_session():
    """Is this retailer session still valid? Also returns the current name/email, so a rename by
    an admin shows up without logging out."""
    if not _USER_AUTH_AVAILABLE:
        return jsonify({"success": False, "error": _USER_AUTH_IMPORT_ERROR}), 503
    user, err = _require_user()
    if err:
        return err
    return jsonify({"success": True, "user": _public_user(user)})


@app.route("/api/auth/welcome-seen", methods=["POST"])
def api_auth_welcome_seen():
    """The signed-in public user closed their one-time welcome popup — never show it again."""
    if not _USER_AUTH_AVAILABLE:
        return jsonify({"success": False, "error": _USER_AUTH_IMPORT_ERROR}), 503
    user, err = _require_user()
    if err:
        return err
    mark_user_welcomed(user["id"])
    return jsonify({"success": True})


@app.route("/api/auth/logout", methods=["POST"])
def api_auth_logout():
    if not _USER_AUTH_AVAILABLE:
        return jsonify({"success": False, "error": _USER_AUTH_IMPORT_ERROR}), 503
    token = _user_token_from_request()
    who = get_session_user(token)
    revoke_user_session(token)
    if who:
        user_add_activity(who["id"], "INFO", "Signed out")
    return jsonify({"success": True})


@app.route("/api/auth/profile", methods=["GET"])
def api_auth_get_profile():
    if not _USER_AUTH_AVAILABLE:
        return jsonify({"success": False, "error": _USER_AUTH_IMPORT_ERROR}), 503
    user, err = _require_user()
    if err:
        return err
    return jsonify({"success": True, "user": _public_user(user)})


@app.route("/api/auth/profile", methods=["PUT"])
def api_auth_update_profile():
    """Partial update, like the admin profile: only the fields sent change (the photo and the
    additional-info rows save on their own). The account is the session's; the body's "email"
    is the NEW login email (legacy clients sent it as "new_email")."""
    if not _USER_AUTH_AVAILABLE:
        return jsonify({"success": False, "error": _USER_AUTH_IMPORT_ERROR}), 503
    user, err = _require_user()
    if err:
        return err
    payload = request.get_json(silent=True) or {}
    patch = {k: payload[k] for k in ("name", "title", "phone", "bio", "avatar", "extra_info") if k in payload}
    if "new_email" in payload or "email" in payload:
        patch["email"] = payload.get("new_email", payload.get("email"))
    try:
        ok, msg = user_update_profile(user["id"], patch)
        if not ok:
            return jsonify({"success": False, "error": msg}), 400
        # Recent Activity keeps to sign-in and security events, like the admin profile's; of the
        # profile fields only a change of the login email is one.
        if "email" in patch and str(patch["email"] or "").strip().lower() != user["email"]:
            user_add_activity(user["id"], "WARN", "Login email changed")
        user = get_session_user(_user_token_from_request()) or user
        return jsonify({"success": True, "message": msg, "user": _public_user(user)})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


@app.route("/api/auth/activity", methods=["GET"])
def api_auth_activity():
    """This account's own recent sign-in and account events (Profile → Recent Activity)."""
    if not _USER_AUTH_AVAILABLE:
        return jsonify({"success": False, "error": _USER_AUTH_IMPORT_ERROR}), 503
    user, err = _require_user()
    if err:
        return err
    try:
        limit = int(request.args.get("limit", 6))
    except ValueError:
        limit = 6
    return jsonify({"success": True, "ready": True, "logs": user_list_activity(user["id"], limit)})


@app.route("/api/auth/change-password", methods=["POST"])
def api_auth_change_password():
    if not _USER_AUTH_AVAILABLE:
        return jsonify({"success": False, "error": _USER_AUTH_IMPORT_ERROR}), 503
    user, err = _require_user()
    if err:
        return err
    # Keyed to the account, not the IP, so rotating addresses does not buy more guesses.
    lock_key = f"user:{user['id']}"
    ok_lock, lock_msg = user_check_lockout(CHANGE_PASSWORD_ATTEMPTS, lock_key)
    if not ok_lock:
        return jsonify({"success": False, "error": lock_msg}), 429
    payload = request.get_json(silent=True) or {}
    try:
        ok, msg = change_password_for_user(user["email"], payload.get("current"), payload.get("new"))
        if not ok:
            if msg == WRONG_CURRENT_PASSWORD_MSG:
                user_record_failure(CHANGE_PASSWORD_ATTEMPTS, lock_key)
                user_add_activity(user["id"], "WARN", "Password change failed (wrong current password)")
                if not user_check_lockout(CHANGE_PASSWORD_ATTEMPTS, lock_key)[0]:
                    user_add_activity(user["id"], "ERROR", "Password changes locked for 15 minutes after too many wrong passwords")
            return jsonify({"success": False, "error": msg}), 400
        user_clear_failures(CHANGE_PASSWORD_ATTEMPTS, lock_key)
        user_add_activity(user["id"], "INFO", "Password changed (other devices signed out)")
        # Other devices signed in with the old password are signed out; this one stays in.
        revoke_user_sessions(user["id"], keep_token=_user_token_from_request())
        return jsonify({"success": True, "message": msg})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


# ══════════════════════════════════════════════
# USER MANAGEMENT (Admin → User Management; see model/user_management.py)
# ══════════════════════════════════════════════

try:
    import user_management as _um
    _UM_AVAILABLE = True
except ImportError as _um_err:
    _UM_AVAILABLE = False
    _UM_IMPORT_ERROR = str(_um_err)


def _um_guard(super_only: bool = True):
    """(identity, None) for a signed-in admin, else (None, error_response). User Management is a
    Super Admin module (public users and admin accounts alike); only /api/admin/me, which every
    admin needs to learn its own role, passes super_only=False."""
    if not _UM_AVAILABLE:
        return None, (jsonify({"success": False, "error": _UM_IMPORT_ERROR}), 503)
    if not _ADMIN_AUTH_AVAILABLE:
        return None, (jsonify({"success": False, "error": "Admin authentication is unavailable."}), 503)
    me = session_identity(_admin_token_from_request())
    if not me:
        return None, (jsonify({"success": False, "error": "Admin session required."}), 401)
    if super_only and me.get("must_change_credentials"):
        return None, _must_change_response()
    if super_only and me.get("role") != "super_admin":
        return None, (jsonify({"success": False, "error": "Only a Super Admin can manage user accounts.",
                               "code": "super_admin_only"}), 403)
    return me, None


def _um_result(ok, msg, data, me, action):
    if not ok:
        return jsonify({"success": False, "error": msg}), 400
    _add_log("INFO", f"{msg} (by {me.get('username')})", source="USERS")
    return jsonify({"success": True, "message": msg, "account": data, "action": action})


@app.route("/api/admin/me", methods=["GET"])
def api_admin_me():
    me, err = _um_guard(super_only=False)
    if err:
        return err
    return jsonify({"success": True, "admin": me, "show_welcome": _um.welcome_pending(me)})


@app.route("/api/admin/me/welcome-seen", methods=["POST"])
def api_admin_me_welcome_seen():
    """The signed-in admin closed their one-time welcome popup."""
    me, err = _um_guard(super_only=False)
    if err:
        return err
    if me.get("kind") == "account":
        _um.store.mark_admin_welcomed(me["id"])
    return jsonify({"success": True})


@app.route("/api/admin/me/avatar", methods=["PUT"])
def api_admin_me_avatar():
    """Any admin (either role) may change their own profile photo; "" removes it."""
    me, err = _um_guard(super_only=False)
    if err:
        return err
    ok, msg, avatar = _um.set_own_avatar(me, (request.get_json(silent=True) or {}).get("avatar"))
    if not ok:
        return jsonify({"success": False, "error": msg}), 400
    _add_log("INFO", f"Admin '{me.get('username')}' {'changed' if avatar else 'removed'} their profile photo", source="USERS")
    return jsonify({"success": True, "message": msg, "avatar": avatar})


@app.route("/api/admin/accounts/users/<int:user_id>", methods=["GET"])
def api_admin_accounts_user_detail(user_id):
    """One public user's profile summary plus recent account activity (User Management popup)."""
    me, err = _um_guard()
    if err:
        return err
    detail = _um.user_detail(user_id)
    if not detail:
        return jsonify({"success": False, "error": "Account not found."}), 404
    return jsonify({"success": True, "account": detail})


@app.route("/api/admin/accounts", methods=["GET"])
def api_admin_accounts_list():
    me, err = _um_guard()
    if err:
        return err
    try:
        return jsonify({"success": True, **_um.list_accounts(me)})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


@app.route("/api/admin/accounts/users", methods=["POST"])
def api_admin_accounts_user_create():
    me, err = _um_guard()
    if err:
        return err
    ok, msg, data = _um.create_user(request.get_json(silent=True) or {})
    return _um_result(ok, msg, data, me, "created")


def _confirm_pin_error(me: dict, payload: dict, what: str):
    """Account changes in User Management (edit, deactivate, reactivate) are re-authenticated: the
    request must carry the acting admin's own 6-digit PIN as `confirm_pin`. Checked with the same
    lockout as sign-in (5 wrong → 15 minutes). Returns an error response, or None when it matches.
    The PIN is removed from `payload` either way, so it is never passed on or stored."""
    pin = payload.pop("confirm_pin", "")
    client_key = _admin_client_key()
    for key in (client_key, _account_key(me.get("username"))):
        ok_lock, lock_msg = check_lockout(key)
        if not ok_lock:
            return jsonify({"success": False, "error": lock_msg, "code": "locked"}), 429
    if not verify_admin_pin(me, pin):
        record_failure(client_key)
        record_failure(_account_key(me.get("username")))
        _add_log("WARN", f"Wrong PIN confirming {what} by '{me.get('username')}'", source="USERS")
        return jsonify({"success": False, "error": "That PIN is incorrect.", "code": "pin_invalid"}), 403
    return None


@app.route("/api/admin/accounts/users/<int:user_id>", methods=["PUT"])
def api_admin_accounts_user_update(user_id):
    """Edit a public user (confirmed with the acting admin's PIN, see _confirm_pin_error)."""
    me, err = _um_guard()
    if err:
        return err
    payload = request.get_json(silent=True) or {}
    bad = _confirm_pin_error(me, payload, f"an edit of public user #{user_id}")
    if bad:
        return bad
    ok, msg, data = _um.update_user(user_id, payload)
    return _um_result(ok, msg, data, me, "updated")


@app.route("/api/admin/accounts/users/<int:user_id>/status", methods=["POST"])
def api_admin_accounts_user_status(user_id):
    me, err = _um_guard()
    if err:
        return err
    payload = request.get_json(silent=True) or {}
    active = bool(payload.get("active"))
    bad = _confirm_pin_error(me, payload, f"{'reactivating' if active else 'deactivating'} public user #{user_id}")
    if bad:
        return bad
    ok, msg, data = _um.set_user_active(user_id, active)
    return _um_result(ok, msg, data, me, "reactivated" if active else "deactivated")


@app.route("/api/admin/accounts/admins", methods=["POST"])
def api_admin_accounts_admin_create():
    me, err = _um_guard()
    if err:
        return err
    ok, msg, data = _um.create_admin(request.get_json(silent=True) or {}, me)
    return _um_result(ok, msg, data, me, "created")


@app.route("/api/admin/accounts/admins/<int:admin_id>", methods=["PUT"])
def api_admin_accounts_admin_update(admin_id):
    me, err = _um_guard()
    if err:
        return err
    payload = request.get_json(silent=True) or {}
    bad = _confirm_pin_error(me, payload, f"an edit of admin #{admin_id}")
    if bad:
        return bad
    ok, msg, data = _um.update_admin(admin_id, payload, me)
    return _um_result(ok, msg, data, me, "updated")


@app.route("/api/admin/accounts/admins/<int:admin_id>/status", methods=["POST"])
def api_admin_accounts_admin_status(admin_id):
    me, err = _um_guard()
    if err:
        return err
    payload = request.get_json(silent=True) or {}
    active = bool(payload.get("active"))
    bad = _confirm_pin_error(me, payload, f"{'reactivating' if active else 'deactivating'} admin #{admin_id}")
    if bad:
        return bad
    ok, msg, data = _um.set_admin_active(admin_id, active, me)
    return _um_result(ok, msg, data, me, "reactivated" if active else "deactivated")



# ══════════════════════════════════════════════
# REPORTS & EXPORT
# ══════════════════════════════════════════════

try:
    from reports_export import (
        delete_file as reports_delete_file,
        generate as reports_generate,
        list_history as reports_list_history,
        resolve_download as reports_resolve_download,
    )
    _REPORTS_AVAILABLE = True
except ImportError as _reports_err:
    _REPORTS_AVAILABLE = False
    _REPORTS_IMPORT_ERROR = str(_reports_err)


@app.route("/api/reports/history", methods=["GET"])
def api_reports_history():
    if not _REPORTS_AVAILABLE:
        return jsonify({"ready": False, "error": _REPORTS_IMPORT_ERROR}), 503
    try:
        return jsonify({"ready": True, "files": reports_list_history()})
    except Exception as exc:
        return jsonify({"ready": False, "error": str(exc)}), 500


@app.route("/api/reports/generate", methods=["POST"])
def api_reports_generate():
    if not _REPORTS_AVAILABLE:
        return jsonify({"success": False, "error": _REPORTS_IMPORT_ERROR}), 503
    ok, resp = _require_admin()
    if not ok:
        return resp
    payload = request.get_json(silent=True) or {}
    export_type = payload.get("type") or payload.get("export_type")
    if not export_type:
        return jsonify({"success": False, "error": "Missing export type"}), 400
    try:
        file_info = reports_generate(export_type)
        return jsonify({"success": True, "file": file_info})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


@app.route("/api/reports/download/<path:filename>", methods=["GET"])
def api_reports_download(filename: str):
    if not _REPORTS_AVAILABLE:
        return jsonify({"error": _REPORTS_IMPORT_ERROR}), 503
    path = reports_resolve_download(filename)
    if not path:
        return jsonify({"error": "File not found"}), 404
    return send_from_directory(
        os.path.dirname(path),
        os.path.basename(path),
        as_attachment=True,
    )


@app.route("/api/reports/file/<path:filename>", methods=["DELETE"])
def api_reports_delete_file(filename: str):
    if not _REPORTS_AVAILABLE:
        return jsonify({"success": False, "error": _REPORTS_IMPORT_ERROR}), 503
    ok, resp = _require_super_admin()
    if not ok:
        return resp
    if not reports_delete_file(filename):
        return jsonify({"success": False, "error": "File not found"}), 404
    return jsonify({"success": True})


# ─── Frontend (same origin as API — open http://127.0.0.1:5000/) ─────────────
# Top-level folders the static route may serve. Everything else under PROJECT_ROOT — the SQLite
# databases, the Python source, model artefacts, .env — stays unreachable over HTTP.
SERVABLE_ROOTS = frozenset({"public", "admin", "css", "js"})


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_frontend(path: str):
    """Serve public site + admin dashboard from project folders.

    Only the four front-end folders are web-servable. This route previously served anything under
    PROJECT_ROOT, which meant an unauthenticated GET could download
    `datasets/agriprice_database.db` (the entire ~1 MB database), any `model/*.py` including
    `admin_auth.py`, `model/training_history.json`, and — once a user registers —
    `model/agriprice_users.db`, which holds the werkzeug password hashes. Nothing outside these
    folders is needed by the browser: `public/*.html` references `assets/`, `css/` and `js/`
    relative to itself, and the admin SPA fetches only `/admin/**` and `/api/**`.
    """
    if path.startswith("api"):
        abort(404)
    safe = path.replace("\\", "/").lstrip("/")
    # Redirect the site root to the public landing page so its relative asset paths
    # (css/…, js/…) resolve under /public/ — serving it at "/" 404s those assets,
    # which drops the nav bar and the JS-rendered price widgets.
    if not safe or safe == "index.html":
        return redirect("/public/landpage.html", code=302)

    root = safe.split("/", 1)[0]
    if root not in SERVABLE_ROOTS:
        abort(404)

    full = os.path.join(PROJECT_ROOT, safe)
    if os.path.isfile(full):
        return _revalidate(send_from_directory(PROJECT_ROOT, safe))
    if safe.startswith("admin/") and "." not in os.path.basename(safe):
        return _revalidate(send_from_directory(os.path.join(PROJECT_ROOT, "admin"), "index.html"))
    return redirect("/public/landpage.html", code=302)


def _revalidate(resp):
    """Make the browser re-check page code on every load instead of reusing a stale copy.

    Without a Cache-Control header browsers cache HTML/JS/CSS heuristically, so after a `git pull`
    a page could keep running last week's script against this week's API (or new HTML against an
    old script) and sit on "Loading…". `no-cache` still lets the browser keep the file; it just
    asks first, and an unchanged file costs a body-less 304. Images keep the default caching.
    """
    if (resp.mimetype or "").startswith(("text/", "application/javascript")):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


# ─── CLI entry point ──────────────────────────────────────────────────────────
def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="AgriPricePH — unified API server & scraper console",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--once",  action="store_true", help="Run one scrape cycle then exit")
    mode.add_argument("--loop",  action="store_true", help="Run scrape in a loop forever")
    mode.add_argument("--serve", action="store_true", help="Start Flask API server (default)")

    p.add_argument("--interval", type=int, default=DEFAULT_INTERVAL,
                   help=f"Loop/auto-scrape interval in seconds (default: {DEFAULT_INTERVAL})")
    p.add_argument("--port",    type=int, default=5000,  help="Flask port (default: 5000)")
    p.add_argument("--host",    default="127.0.0.1",     help="Flask host (default: 127.0.0.1)")
    return p.parse_args()


def main() -> int:
    args = _parse_args()
    _setup_logging()

    # ── --once: single scrape, then exit ──────────────────────────────────────
    if args.once:
        print("AgriPricePH — Single Run Mode")
        ok = _do_scrape()
        return 0 if ok else 1

    # ── --loop: continuous scrape loop, no Flask ───────────────────────────────
    if args.loop:
        print(f"AgriPricePH — Loop Mode (interval: {args.interval}s)")
        try:
            _loop_scraper(args.interval)
        except KeyboardInterrupt:
            print("\nStopped.")
        return 0

    # ── default / --serve: Flask API server + background auto-scrape ──────────
    print("AgriPricePH — API Server Mode")
    _auto_import_2026()
    print(f"  Dashboard     http://{args.host}:{args.port}/")
    print(f"  API           http://{args.host}:{args.port}/api/")
    print(f"  Auto-scrape   every {args.interval}s")
    print(f"  Endpoints:")
    print(f"    GET  /api/historical-data")
    print(f"    GET  /api/scrape-status")
    print(f"    GET  /api/data-sources")
    print(f"    POST /api/run-scraper")
    print(f"    GET  /api/stream-scrape  (SSE)")
    print(f"    GET  /api/health")
    print(f"    POST /api/run-training")
    print(f"    POST /api/cancel-training")
    print(f"    GET  /api/training-status")
    print(f"    GET  /api/training-history")
    print(f"    GET  /api/dashboard-metrics")
    print(f"    GET  /api/predictions")
    print(f"    GET  /api/settings")
    print(f"    PUT  /api/settings")
    print(f"    GET  /api/alerts")
    print(f"    POST /api/alerts/evaluate")
    print(f"    GET  /api/model-status")
    print(f"    GET  /api/reports/history")
    print(f"    POST /api/reports/generate")
    print(f"    POST /api/save-export")
    print(f"  Database: {DB_PATH}")
    print()

    def _warm_lstm_cache():
        log = logging.getLogger("agriprice_scraper")
        try:
            try:
                from privacy import harden_file_permissions
                log.info("Privacy: %s", harden_file_permissions())
            except Exception as exc:
                log.warning("Privacy hardening skipped: %s", exc)
            from predict import warm_cache, warm_payload
            n = warm_cache()
            log.info("LSTM cache warmed: %s model(s) loaded", n)
            # Also build the forecast payload once, so the first visitor after a restart is not
            # the one who pays for conformal calibration across all 8 rice types.
            if warm_payload():
                log.info("Forecast payload pre-built; /api/predictions now serves from cache")
        except Exception as exc:
            log.warning("LSTM cache warm-up skipped: %s", exc)

    # Start background auto-scrape loop (LSTM warm-up runs after — avoids blocking scrape)
    threading.Thread(
        target=_loop_scraper, args=(args.interval,), daemon=True
    ).start()

    threading.Thread(target=_warm_lstm_cache, daemon=True).start()

    def _startup_alert_check() -> None:
        if not _ALERTS_AVAILABLE:
            return
        try:
            evaluate_alerts()
        except Exception as exc:
            logging.getLogger("agriprice_scraper").warning(
                "Startup alert check skipped: %s", exc
            )

    threading.Thread(target=_startup_alert_check, daemon=True).start()

    try:
        app.run(host=args.host, port=args.port, threaded=True, use_reloader=False)
    except KeyboardInterrupt:
        print("\nServer stopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
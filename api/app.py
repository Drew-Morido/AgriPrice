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
from datetime import date, datetime



import pandas as pd
from flask import Flask, Response, abort, jsonify, redirect, request, send_from_directory
from flask_cors import CORS

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
    from scrap import fetch_rice_prices, fetch_exchange_rates, fetch_fuel_prices
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

# ─── Paths ────────────────────────────────────────────────────────────────────
BASE_DIR     = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)

# Historical SQLite DB (used by /api/historical-data and ML training)
_DATASETS_DB = os.path.join(PROJECT_ROOT, "datasets", "agriprice_database.db")
_API_DB = os.path.join(BASE_DIR, "agriprice_database.db")
DB_PATH = _DATASETS_DB if os.path.exists(_DATASETS_DB) else _API_DB

MODEL_DIR = os.path.join(PROJECT_ROOT, "model")
DATASETS_DIR = os.path.join(PROJECT_ROOT, "datasets")
if MODEL_DIR not in sys.path:
    sys.path.insert(0, MODEL_DIR)
if DATASETS_DIR not in sys.path:
    sys.path.insert(0, DATASETS_DIR)

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
_last_source_ts: dict[str, datetime | None] = {"da": None, "doe": None, "api": None}
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


def _do_scrape() -> bool:
    """
    Runs rice → fuel → exchange-rate scraping sequentially.
    Logs each step in real-time (visible via SSE stream and /api/scrape-status).
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
    results = {"rice": False, "fuel": False, "rates": False}

    try:
        if not _SCRAPER_AVAILABLE:
            logger.error("Scraper modules not installed: %s", _SCRAPER_IMPORT_ERROR)
            logger.info("Install: pip install pdfplumber requests beautifulsoup4")
            _add_log("ERROR", f"Scraper import failed: {_SCRAPER_IMPORT_ERROR}")
            _last_scrape_ok = False
            return False

        _add_log("INFO", "Scrape job started (rice → fuel → exchange rates)")
        logger.info("SCRAPPING IS INITIATING...")

        # ── STEP 1: Rice prices ──────────────────────────────────────────────
        logger.info("DA-AMAS IS SCRAPING NOW // https://www.da.gov.ph/price-monitoring/")
        try:
            ok = fetch_rice_prices()
            results["rice"] = bool(ok)
            if ok:
                _last_source_ts["da"] = datetime.now()
            elif not ok:
                logger.warning("DA-AMAS rice scrape failed — check logs above.")
        except Exception as exc:
            logger.error("FAILED AT DA-AMAS: %s", exc)

        # ── STEP 2: Fuel prices ──────────────────────────────────────────────
        logger.info("DATA FUEL IS SCRAPING NOW // https://www.zigwheels.ph/fuel-price")
        try:
            ok = fetch_fuel_prices()
            results["fuel"] = bool(ok)
            if ok:
                _last_source_ts["doe"] = datetime.now()
            elif not ok:
                logger.warning("ALREADY SCRAPPED OR FAILED TO FETCH FUEL")
        except Exception as exc:
            logger.error("FAILED AT FUEL DATA: %s", exc)

        # ── STEP 3: Exchange rates ───────────────────────────────────────────
        logger.info("RATE EXCHANGE IS SCRAPING NOW // https://open.er-api.com/v6/latest/USD")
        try:
            ok = fetch_exchange_rates()
            results["rates"] = bool(ok)
            if ok:
                _last_source_ts["api"] = datetime.now()
            elif not ok:
                logger.warning("ALREADY SCRAPPED OR FAILED TO FETCH EXCHANGE RATES")
        except Exception as exc:
            logger.error("FAILED AT EXCHANGE RATES: %s", exc)

        # ── Summary ──────────────────────────────────────────────────────────
        any_ok = any(results.values())
        all_ok = all(results.values())

        logger.info("")
        logger.info("---------------------------------------")
        logger.info("  SUMMARY")
        logger.info("  Rice   : %s", "OK" if results["rice"] else "FAILED")
        logger.info("  Fuel   : %s", "OK" if results["fuel"] else "FAILED")
        logger.info("  Rates  : %s", "OK" if results["rates"] else "FAILED")
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
        return any_ok

    except Exception as exc:
        logger.error("Unexpected scrape error: %s", exc)
        _add_log("ERROR", f"Scrape failed: {exc}")
        _last_scrape_ok = False
        return False
    finally:
        _release_scrape_lock()


def _do_scrape_one(source_id: str) -> bool:
    """Run scraper for a single source (da | doe | api)."""
    global _scrape_running, _last_scrape_ts, _last_scrape_ok

    fetch_map = {
        "da":  fetch_rice_prices,
        "doe": fetch_fuel_prices,
        "api": fetch_exchange_rates,
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


def _loop_scraper(interval: int) -> None:
    """Background auto-scrape loop. Used in --loop and server modes."""
    logger = logging.getLogger("agriprice_scraper")
    logger.info("Auto-scraper loop started. Interval: %ss", interval)
    # Let Flask respond before the first scrape (avoids "stuck on Running" on page load)
    time.sleep(15)
    while True:
        start = time.time()
        _do_scrape()
        elapsed = time.time() - start
        sleep_for = max(60, int(interval - elapsed))
        logger.info("Next auto-scrape in %ss", sleep_for)
        time.sleep(sleep_for)


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
    dates = pd.to_datetime(pd.concat(frames, ignore_index=True), errors="coerce").dropna()
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


def _build_row_summary(latest: dict, expected_cols: list) -> list:
    """Human-readable field list from the latest DB row (for modal detail)."""
    out: list[dict] = []
    date_val = latest.get("Date")
    if date_val is not None and not (isinstance(date_val, float) and pd.isna(date_val)):
        out.append({"label": "Date", "value": str(date_val)})

    src = latest.get("Source")
    if src is not None and not (isinstance(src, float) and pd.isna(src)):
        label = "Estimated (temporary)" if str(src).lower() == "estimated" else "DA official"
        out.append({"label": "Source", "value": label})

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
CORS(app)


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
        "Gasoline", "RON_100", "RON_97", "RON_95", "RON_91",
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
    }

    return jsonify({
        "logs":          logs,
        "stats":         stats,
    })


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


@app.route("/api/data-sources", methods=["GET"])
def api_data_sources():
    """Live metadata for Data Sources page (historical + scraped DB counts)."""
    EXPECTED_RICE  = [
        "Local Special", "Local Premium", "Local Well Milled", "Local Regular Milled",
        "Imported Special", "Imported Premium", "Imported Well Milled", "Imported Regular Milled",
    ]
    EXPECTED_FUEL  = [
        "Gasoline", "RON_100", "RON_97", "RON_95", "RON_91",
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
            "doe", "Zigwheels (Fuel)",
            "Web Scraper (BeautifulSoup)",
            "Diesel & Fuel Prices (Weekly)",
            "https://www.zigwheels.ph/fuel-price",
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
    Triggers scrape in background. Optional JSON body: {"source": "da"|"doe"|"api"}.
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
@app.route("/api/historical-data", methods=["GET"])
def get_historical_data():
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
        df_fuel_ws = pd.read_sql('SELECT Date, RON_95 AS fuel FROM "WS_fuel"', conn)
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
    df_final["Date"] = df_final["Date"].dt.strftime("%m/%d/%Y")
    df_final = df_final.ffill().bfill().fillna(0)

    # ── 5. Build response ─────────────────────────────────────────────────────
    return jsonify({
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
        },
    })




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

    acc = entry.get("accuracy_pct")
    if acc is not None:
        if acc >= 95:
            insights.append(
                f"Estimated accuracy is {acc}% on held-out data — strong for rice price forecasting."
            )
        elif acc >= 85:
            insights.append(
                f"Estimated accuracy is {acc}% — acceptable; additional runs may refine forecasts."
            )
        else:
            insights.append(
                f"Estimated accuracy is {acc}% — review scraper data freshness and training samples."
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
            from predict import invalidate_caches
            invalidate_caches()
            _add_train_log("INFO", "Prediction cache cleared — new LSTM weights will load on next request.")
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

    by_target = {}
    for key, tm in targets_meta.items():
        if not isinstance(tm, dict):
            continue
        by_target[key] = {
            "mae_peso": _f(tm.get("mae_peso")),
            "rmse_peso": _f(tm.get("rmse_peso")),
            "accuracy_pct": _f(tm.get("accuracy_pct")),
        }

    prev = summaries.get("previous_ok_run")

    return jsonify({
        "ready": bool(latest or meta.get("mae_peso") is not None),
        "source": "training_history" if latest else ("meta.json" if meta else "none"),
        "latest_ok_run": latest,
        "previous_ok_run": prev,
        "metrics": {
            "mae_peso": mae,
            "rmse_peso": rmse,
            "accuracy_pct": _f(latest.get("accuracy_pct") if latest else None) or _f(
                meta.get("accuracy_pct")
            ),
            "avg_accuracy_pct": acc,
            "by_target": by_target,
        },
        "trends": {
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
                "Hold-out test accuracy (2024–2025): estimated as 100% − (MAE ÷ mean rice price × 100), "
                "capped at 99.9%. Same formula used when saving Training History."
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
    return jsonify({
        "running":      _train_running,
        "logs":         logs,
        "last_run":     _last_train_ts.isoformat() if _last_train_ts else None,
        "last_result":  _last_train_result,
        "last_saved_run": _last_saved_run,
        "history":      {"runs": list(reversed(runs)), "total": len(runs)},
    })


# ── /api/run-training ─────────────────────────────────────────────────────────
@app.route("/api/run-training", methods=["POST"])
def api_run_training():
    global _train_running, _train_cancel_requested
    ok, resp = _require_admin()
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
        return jsonify(list_catalog())
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
    ok, resp = _require_admin()
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
@app.route("/api/predictions", methods=["GET"])
def api_predictions():
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
    """Rules + notification log; optional ?evaluate=1 runs live price checks."""
    if not _ALERTS_AVAILABLE:
        return jsonify({"error": _ALERTS_IMPORT_ERROR, "ready": False}), 503
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
    if not _SETTINGS_AVAILABLE:
        return jsonify({"ready": False, "error": _SETTINGS_IMPORT_ERROR}), 503
    try:
        return jsonify({"ready": True, **get_settings()})
    except Exception as exc:
        return jsonify({"ready": False, "error": str(exc)}), 500


@app.route("/api/settings", methods=["PUT"])
def api_put_settings():
    if not _SETTINGS_AVAILABLE:
        return jsonify({"success": False, "error": _SETTINGS_IMPORT_ERROR}), 503
    ok, resp = _require_admin()
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
    ok, resp = _require_admin()
    if not ok:
        return resp
    try:
        result = reset_to_defaults()
        return jsonify({"success": True, **result})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


try:
    from admin_auth import (
        check_lockout,
        clear_failures,
        create_session,
        record_failure,
        revoke_session,
        validate_session,
        verify_admin_credentials,
        verify_admin_password,
    )
    _ADMIN_AUTH_AVAILABLE = True
except ImportError as _admin_auth_err:
    _ADMIN_AUTH_AVAILABLE = False
    _ADMIN_AUTH_IMPORT_ERROR = str(_admin_auth_err)


def _admin_client_key():
    return (request.headers.get("X-Forwarded-For") or request.remote_addr or "unknown").split(",")[0].strip()


def _admin_token_from_request():
    auth = request.headers.get("Authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return (request.args.get("token") or request.headers.get("X-Admin-Token") or "").strip()


def _require_admin():
    """Guard for admin write endpoints. Returns (ok, error_response). When admin auth is wired,
    a valid server-side session token is required; if the auth module is unavailable (dev), allow."""
    if not _ADMIN_AUTH_AVAILABLE:
        return True, None
    if validate_session(_admin_token_from_request()):
        return True, None
    return False, (jsonify({"ok": False, "error": "Admin session required."}), 401)


@app.route("/api/admin/verify-password", methods=["POST"])
def api_admin_verify_password():
    """Verify admin username/password only (step 1 before access code)."""
    if not _ADMIN_AUTH_AVAILABLE:
        return jsonify({"success": False, "error": _ADMIN_AUTH_IMPORT_ERROR}), 503
    client_key = _admin_client_key()
    ok_lock, lock_msg = check_lockout(client_key)
    if not ok_lock:
        return jsonify({"success": False, "error": lock_msg}), 429

    payload = request.get_json(silent=True) or {}
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""

    try:
        valid, err = verify_admin_password(username, password)
        if not valid:
            record_failure(client_key)
            return jsonify({"success": False, "error": err or "Invalid sign-in details."}), 401
        clear_failures(client_key)
        return jsonify({"success": True})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


@app.route("/api/admin/verify", methods=["POST"])
def api_admin_verify():
    """Verify admin credentials; return short-lived session token."""
    if not _ADMIN_AUTH_AVAILABLE:
        return jsonify({"success": False, "error": _ADMIN_AUTH_IMPORT_ERROR}), 503
    client_key = _admin_client_key()
    ok_lock, lock_msg = check_lockout(client_key)
    if not ok_lock:
        _add_log("WARN", f"Admin login blocked (locked out) from {client_key}", source="AUTH")
        return jsonify({"success": False, "error": lock_msg}), 429

    payload = request.get_json(silent=True) or {}
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""
    access_code = "".join(ch for ch in str(payload.get("access_code", "")) if ch.isdigit())

    try:
        valid, err = verify_admin_credentials(username, password, access_code)
        if not valid:
            record_failure(client_key)
            _add_log("WARN", f"Failed admin login for '{username or '?'}' from {client_key}", source="AUTH")
            return jsonify({"success": False, "error": err or "Invalid sign-in details."}), 401
        clear_failures(client_key)
        token, ttl_sec = create_session(client_key)
        _add_log("INFO", f"Admin '{username}' signed in from {client_key}", source="AUTH")
        return jsonify({
            "success": True,
            "token": token,
            "expires_in": ttl_sec,
        })
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


@app.route("/api/admin/session", methods=["GET"])
def api_admin_session():
    if not _ADMIN_AUTH_AVAILABLE:
        return jsonify({"valid": False, "error": _ADMIN_AUTH_IMPORT_ERROR}), 503
    token = _admin_token_from_request()
    if validate_session(token):
        return jsonify({"valid": True})
    return jsonify({"valid": False}), 401


@app.route("/api/admin/logout", methods=["POST"])
def api_admin_logout():
    if not _ADMIN_AUTH_AVAILABLE:
        return jsonify({"success": False}), 503
    revoke_session(_admin_token_from_request())
    return jsonify({"success": True})


@app.route("/api/settings/password", methods=["POST"])
def api_change_password():
    if not _SETTINGS_AVAILABLE:
        return jsonify({"success": False, "error": _SETTINGS_IMPORT_ERROR}), 503
    ok_admin, resp = _require_admin()
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
        LOGIN_ATTEMPTS,
        RESET_REQUEST_ATTEMPTS,
        RESET_VERIFY_ATTEMPTS,
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
    from user_store import update_profile as user_update_profile
    from mailer import is_configured as mailer_is_configured
    _USER_AUTH_AVAILABLE = True
except ImportError as _user_auth_err:
    _USER_AUTH_AVAILABLE = False
    _USER_AUTH_IMPORT_ERROR = str(_user_auth_err)


@app.route("/api/auth/signup", methods=["POST"])
def api_auth_signup():
    if not _USER_AUTH_AVAILABLE:
        return jsonify({"success": False, "error": _USER_AUTH_IMPORT_ERROR}), 503
    payload = request.get_json(silent=True) or {}
    try:
        ok, msg = signup_user(payload.get("name"), payload.get("email"), payload.get("password"))
        if not ok:
            return jsonify({"success": False, "error": msg}), 400
        return jsonify({"success": True})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


@app.route("/api/auth/login", methods=["POST"])
def api_auth_login():
    if not _USER_AUTH_AVAILABLE:
        return jsonify({"success": False, "error": _USER_AUTH_IMPORT_ERROR}), 503
    client_key = _admin_client_key()
    ok_lock, lock_msg = user_check_lockout(LOGIN_ATTEMPTS, client_key)
    if not ok_lock:
        return jsonify({"success": False, "error": lock_msg}), 429

    payload = request.get_json(silent=True) or {}
    try:
        ok, msg, user = login_user(payload.get("email"), payload.get("password"))
        if not ok:
            user_record_failure(LOGIN_ATTEMPTS, client_key)
            return jsonify({"success": False, "error": msg}), 401
        user_clear_failures(LOGIN_ATTEMPTS, client_key)
        return jsonify({"success": True, "user": user})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


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
    if status == "mail_error":
        return jsonify({"success": False, "error": "Could not send the code right now. Try again shortly."}), 502
    user_clear_failures(RESET_REQUEST_ATTEMPTS, client_key)
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
        return jsonify({"success": True, "message": msg})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


@app.route("/api/auth/profile", methods=["PUT"])
def api_auth_update_profile():
    if not _USER_AUTH_AVAILABLE:
        return jsonify({"success": False, "error": _USER_AUTH_IMPORT_ERROR}), 503
    payload = request.get_json(silent=True) or {}
    try:
        ok, msg = user_update_profile(payload.get("email"), payload.get("name"), payload.get("new_email"))
        if not ok:
            return jsonify({"success": False, "error": msg}), 400
        return jsonify({"success": True, "message": msg})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


@app.route("/api/auth/change-password", methods=["POST"])
def api_auth_change_password():
    if not _USER_AUTH_AVAILABLE:
        return jsonify({"success": False, "error": _USER_AUTH_IMPORT_ERROR}), 503
    payload = request.get_json(silent=True) or {}
    try:
        ok, msg = change_password_for_user(payload.get("email"), payload.get("current"), payload.get("new"))
        if not ok:
            return jsonify({"success": False, "error": msg}), 400
        return jsonify({"success": True, "message": msg})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


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
    ok, resp = _require_admin()
    if not ok:
        return resp
    if not reports_delete_file(filename):
        return jsonify({"success": False, "error": "File not found"}), 404
    return jsonify({"success": True})


# ── /api/save-export ──────────────────────────────────────────────────────────
@app.route("/api/save-export", methods=["POST"])
def save_export():
    """Saves a CSV string sent by the frontend to disk under documents/<module>/."""
    try:
        data        = request.json
        module_name = data.get("module",   "General")
        filename    = data.get("filename", "export.csv")
        csv_content = data.get("csv_data", "")

        documents_dir = os.path.join(BASE_DIR, "documents", module_name)
        os.makedirs(documents_dir, exist_ok=True)

        filepath = os.path.join(documents_dir, filename)
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(csv_content)

        return jsonify({"success": True, "message": f"File saved to {filepath}"})

    except Exception as e:
        print(f"Export Error: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


# ─── Frontend (same origin as API — open http://127.0.0.1:5000/) ─────────────
@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_frontend(path: str):
    """Serve public site + admin dashboard from project folders."""
    if path.startswith("api"):
        abort(404)
    safe = path.replace("\\", "/").lstrip("/")
    # Redirect the site root to the public landing page so its relative asset paths
    # (css/…, js/…) resolve under /public/ — serving it at "/" 404s those assets,
    # which drops the nav bar and the JS-rendered price widgets.
    if not safe or safe == "index.html":
        return redirect("/public/landpage.html", code=302)
    full = os.path.join(PROJECT_ROOT, safe)
    if os.path.isfile(full):
        return send_from_directory(PROJECT_ROOT, safe)
    if safe.startswith("admin/") and "." not in os.path.basename(safe):
        return send_from_directory(os.path.join(PROJECT_ROOT, "admin"), "index.html")
    return redirect("/public/landpage.html", code=302)


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
            from predict import warm_cache
            n = warm_cache()
            log.info("LSTM cache warmed: %s model(s) loaded", n)
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
import sqlite3

import argparse
import logging
import os
import re
import sys
import time
from datetime import date, datetime, timedelta
from threading import Lock
from typing import Dict, List, Optional, Tuple
from urllib.parse import urljoin

import pandas as pd
import requests
from bs4 import BeautifulSoup

from pdfconvrt import TARGET_ORDER, extract_rice_prices_from_pdf_bytes
from scrape_guard import check_rice_row, queue
from rice_estimate import (
    SOURCE_ESTIMATED,
    SOURCE_OFFICIAL,
    estimate_rice_prices_for_date,
    format_row as format_estimated_row,
    load_official_rice_history,
)

DEFAULT_INTERVAL_SECONDS = 24 * 60 * 60
REQUEST_TIMEOUT = 45
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
DA_URL = "https://www.da.gov.ph/price-monitoring/"
FUEL_URL = "https://doe.gov.ph/data-and-prices/liquid-fuels/retail-pump-prices/ncr-pump-prices"
RATE_URL = "https://open.er-api.com/v6/latest/USD"
# open.er-api.com only serves today's rate, so a day the scraper did not run stayed empty for good.
# Missed days are filled from this dated daily archive (market mid-rates, weekends included, same kind
# of rate as RATE_URL; within ~PHP 0.10 of it on overlapping days). Rows it writes carry its Source.
RATE_HISTORY_URL = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@{day}/v1/currencies/usd.json"
RATE_HISTORY_MIRROR = "https://{day}.currency-api.pages.dev/v1/currencies/usd.json"   # same archive; has days the CDN lacks
SOURCE_RATE_LIVE = "open_er_api"
SOURCE_RATE_HISTORY = "currency_api_archive"
RATE_MIN_PHP, RATE_MAX_PHP = 40.0, 90.0   # a USD/PHP value outside this is a bad read, not a rate
# How far back each cycle looks for days it missed (scraper or PC off, network down).
CATCHUP_DAYS = 45
TARIFF_FINDER_URL = "https://finder.tariffcommission.gov.ph"

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# Aakyat tayo ng isang folder (papuntang AGRIPRICEPH V3 root)
PROJECT_ROOT = os.path.dirname(BASE_DIR)

# The tariff scraper stages candidates via api/catalog_service.py (validation + audit trail
# already live there for the admin "Add rate" form) instead of writing tariff_schedule directly,
# so there is exactly one place that code exists. Mirrors the sys.path.insert api/app.py already
# does in the other direction to import this module.
API_DIR = os.path.join(PROJECT_ROOT, "api")
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)
try:
    from catalog_service import TARIFF_BAND_MAX, TARIFF_BAND_MIN, add_scraped_tariff_candidate
except ImportError:
    add_scraped_tariff_candidate = None
    TARIFF_BAND_MIN, TARIFF_BAND_MAX = 15.0, 35.0

# Tapos papasok tayo sa existing 'datasets' folder para ma-access ang db
def _resolve_db_path() -> str:
    env = os.environ.get("AGRIPRICE_DB_PATH")
    if env and os.path.isfile(env):
        return env
    datasets_db = os.path.join(PROJECT_ROOT, "datasets", "agriprice_database.db")
    api_db = os.path.join(PROJECT_ROOT, "api", "agriprice_database.db")
    if os.path.isfile(datasets_db):
        return datasets_db
    if os.path.isfile(api_db):
        return api_db
    return datasets_db


DB_PATH = _resolve_db_path()
# -------------------------------------


PRICE_DIR = os.path.join(BASE_DIR, "scrapped price")
RATE_DIR = os.path.join(BASE_DIR, "scrapped rate")
FUEL_DIR = os.path.join(BASE_DIR, "scrapped fuel")
DEBUG_DIR = os.path.join(BASE_DIR, "debug_fetch")
# Every DA bulletin PDF the scraper reads is kept with the other DA source files (datasets/README.md).
DA_PDF_DIR = os.path.join(os.path.dirname(BASE_DIR), "datasets", "3_source_files", "DA-AMAS", "scraper_downloads")

PRICE_CSV = os.path.join(PRICE_DIR, "agriprice_database.csv")
RATE_CSV = os.path.join(RATE_DIR, "exchange_rate_database.csv")
FUEL_CSV = os.path.join(FUEL_DIR, "fuel_database.csv")

for folder in (PRICE_DIR, RATE_DIR, FUEL_DIR, DEBUG_DIR):
    os.makedirs(folder, exist_ok=True)

logger = logging.getLogger("agriprice_scraper")
logger.setLevel(logging.INFO)
# When run via api/app.py, BufferHandler is attached to this logger in _setup_logging()

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": USER_AGENT})

_MONTH_FORMATS = [
    "%B %d, %Y",
    "%b %d, %Y",
    "%B %d %Y",
    "%b %d %Y",
    "%Y-%m-%d",
    "%m/%d/%Y",
]

_DA_LOCK = Lock()

# Only these DA PDFs contain the daily rice price table.
_DAILY_RICE_PDF_MARKERS = ("daily-price-index", "dpi-afc")
_EXCLUDED_PDF_KEYWORDS = (
    "cigarette",
    "tobacco",
    "weekly-average",
    "weekly_average",
    "retail-price",
    "retail_price",
    "price-range",
    "gasoline",
)


def parse_date_any(text: str) -> Optional[datetime]:
    text = (text or "").strip()
    if not text:
        return None

    candidates = [text]
    month_match = re.search(r"([A-Za-z]+\s+\d{1,2},\s*\d{4})", text)
    if month_match:
        candidates.append(month_match.group(1))
    month_hyphen = re.search(r"([A-Za-z]+[-_ ]\d{1,2}[-_ ]\d{4})", text)
    if month_hyphen:
        candidates.append(month_hyphen.group(1).replace("-", " ").replace("_", " "))
    slash_match = re.search(r"(\d{1,2}/\d{1,2}/\d{4})", text)
    if slash_match:
        candidates.append(slash_match.group(1))

    for candidate in candidates:
        cleaned = re.sub(r"\s+", " ", candidate).strip()
        for fmt in _MONTH_FORMATS:
            try:
                return datetime.strptime(cleaned, fmt)
            except ValueError:
                continue
    return None


def formatted_today() -> str:
    return datetime.now().strftime("%m/%d/%Y")


def save_debug_file(filename: str, content: str) -> None:
    path = os.path.join(DEBUG_DIR, filename)
    with open(path, "w", encoding="utf-8", errors="replace") as f:
        f.write(content)


def upsert_csv(csv_path: str, row: Dict) -> None:
    new_df = pd.DataFrame([row])
    if os.path.exists(csv_path):
        old_df = pd.read_csv(csv_path)
        combined = pd.concat([old_df, new_df], ignore_index=True)
        if "Date" in combined.columns:
            combined["_date_sort"] = pd.to_datetime(combined["Date"], errors="coerce")
            combined = combined.sort_values("_date_sort").drop(columns=["_date_sort"])
            combined = combined.drop_duplicates(subset=["Date"], keep="last")
        else:
            combined = combined.drop_duplicates(keep="last")
    else:
        combined = new_df
    combined.to_csv(csv_path, index=False)

def upsert_sqlite(table_name: str, row: Dict) -> None:
    """Nagsasave ng scraped data sa existing SQLite db at nagki-create ng table kung wala pa."""
    conn = sqlite3.connect(DB_PATH)
    new_df = pd.DataFrame([row])
    
    try:
        # Subukang basahin ang existing table para sa deduplication
        old_df = pd.read_sql(f'SELECT * FROM "{table_name}"', conn)
        combined = pd.concat([old_df, new_df], ignore_index=True)
        
        if "Date" in combined.columns:
            combined["_date_sort"] = pd.to_datetime(combined["Date"], errors="coerce")
            combined = combined.sort_values("_date_sort").drop(columns=["_date_sort"])
            # Tanggalin ang duplicates kapag parehas ang Date, keep newest
            combined = combined.drop_duplicates(subset=["Date"], keep="last")
        else:
            combined = combined.drop_duplicates(keep="last")
            
        combined.to_sql(table_name, conn, if_exists="replace", index=False)
    except Exception:
        # Kapag nagka-error (ex. hindi pa nag-eexist yung WS_ table), create new table
        new_df.to_sql(table_name, conn, if_exists="replace", index=False)
    finally:
        conn.close()


def _is_daily_rice_price_pdf(url: str, text: str) -> bool:
    """True only for DA Daily Price Index / DPI-AFC rice bulletins."""
    combined = f"{text} {url}".lower()
    if ".pdf" not in url.lower():
        return False
    if any(kw in combined for kw in _EXCLUDED_PDF_KEYWORDS):
        return False
    return any(marker in combined for marker in _DAILY_RICE_PDF_MARKERS)


def _fallback_da_pdf_urls(days_back: int = 10) -> List[Tuple[datetime, str, str]]:
    """
    Construct likely Daily Price Index URLs when the DA page has no parseable links
    (layout change, blocked HTML, etc.).
    """
    urls: List[Tuple[datetime, str, str]] = []
    today = datetime.now().date()
    for offset in range(days_back + 1):
        d = today - timedelta(days=offset)
        month_name = d.strftime("%B")
        label = d.strftime("%B %d, %Y")
        path = (
            f"https://www.da.gov.ph/wp-content/uploads/{d.year}/{d.month:02d}/"
            f"Daily-Price-Index-{month_name}-{d.day}-{d.year}.pdf"
        )
        urls.append((datetime(d.year, d.month, d.day), label, path))
    return urls


def _iter_pdf_links_in_daily_price_index(soup: BeautifulSoup) -> List[Tuple[Optional[datetime], str, str]]:
    candidates: List[Tuple[Optional[datetime], str, str]] = []

    for a in soup.find_all("a", href=True):
        href = a.get("href", "").strip()
        text = " ".join(a.stripped_strings)
        if not href:
            continue
        absolute = urljoin(DA_URL, href)
        if not _is_daily_rice_price_pdf(absolute, text):
            continue
        dt = parse_date_any(text) or parse_date_any(absolute)
        candidates.append((dt, text or label_from_url(absolute), absolute))

    return candidates


def label_from_url(url: str) -> str:
    name = url.rsplit("/", 1)[-1].replace(".pdf", "").replace("-", " ")
    return name


def list_da_pdfs() -> List[Tuple[Optional[datetime], str, str]]:
    """Every Daily Price Index bulletin linked on the DA page, newest first (undated ones last)."""
    candidates: List[Tuple[Optional[datetime], str, str]] = []
    with _DA_LOCK:
        resp = SESSION.get(DA_URL, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        html = resp.text
        save_debug_file("da_price_monitoring.html", html)
        soup = BeautifulSoup(html, "html.parser")
        candidates = _iter_pdf_links_in_daily_price_index(soup)

    if not candidates:
        logger.warning(
            "No Daily Price Index links on DA page — trying constructed PDF URLs."
        )
        for dt, label, url in _fallback_da_pdf_urls():
            try:
                head = SESSION.head(url, timeout=REQUEST_TIMEOUT, allow_redirects=True)
                if head.status_code == 200:
                    candidates.append((dt, label, url))
            except Exception:
                continue

    dated = sorted((c for c in candidates if c[0] is not None), key=lambda c: c[0], reverse=True)
    return dated + [c for c in candidates if c[0] is None]


def choose_latest_da_pdf() -> Tuple[Optional[datetime], Optional[str], Optional[str]]:
    candidates = list_da_pdfs()
    if not candidates:
        return None, None, None
    return candidates[0]


def download_binary(url: str) -> bytes:
    resp = SESSION.get(url, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    return resp.content


def _ws_rice_has_source_column(conn: sqlite3.Connection) -> bool:
    cur = conn.execute('PRAGMA table_info("WS_rice_price")')
    return any(row[1] == "Source" for row in cur.fetchall())


def _rice_filled_count(row: Dict) -> int:
    return sum(1 for key in TARGET_ORDER if row.get(key) is not None and row.get(key) != "")


def _rice_row_for_date(date_str: str, source: Optional[str] = None) -> bool:
    """True if a row exists for `date_str`, optionally filtered by Source."""
    if not os.path.exists(DB_PATH):
        return False
    try:
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        has_source = _ws_rice_has_source_column(conn)

        if source == SOURCE_ESTIMATED:
            if not has_source:
                conn.close()
                return False
            cur.execute(
                'SELECT 1 FROM "WS_rice_price" WHERE Date = ? AND Source = ? LIMIT 1',
                (date_str, SOURCE_ESTIMATED),
            )
        elif source == SOURCE_OFFICIAL:
            if has_source:
                cur.execute(
                    'SELECT 1 FROM "WS_rice_price" WHERE Date = ? '
                    'AND COALESCE(Source, ?) = ? LIMIT 1',
                    (date_str, SOURCE_OFFICIAL, SOURCE_OFFICIAL),
                )
            else:
                cur.execute(
                    'SELECT 1 FROM "WS_rice_price" WHERE Date = ? LIMIT 1',
                    (date_str,),
                )
        else:
            cur.execute(
                'SELECT 1 FROM "WS_rice_price" WHERE Date = ? LIMIT 1',
                (date_str,),
            )

        found = cur.fetchone() is not None
        conn.close()
        return found
    except Exception:
        return False


def _save_rice_row(row: Dict, label: str) -> None:
    row = dict(row)
    row.setdefault("Source", SOURCE_OFFICIAL)
    upsert_csv(PRICE_CSV, row)
    upsert_sqlite("WS_rice_price", row)
    filled = sum(1 for key in TARGET_ORDER if row.get(key) is not None)
    logger.info(
        "%s — %s (%s/%s rice types) → %s",
        label,
        row.get("Date"),
        filled,
        len(TARGET_ORDER),
        PRICE_CSV,
    )


def _load_rice_row_from_db(date_str: str, source: Optional[str] = None) -> Optional[Dict]:
    if not os.path.exists(DB_PATH):
        return None
    try:
        conn = sqlite3.connect(DB_PATH)
        has_source = _ws_rice_has_source_column(conn)
        if source and has_source:
            df = pd.read_sql(
                'SELECT * FROM "WS_rice_price" WHERE Date = ? AND Source = ? LIMIT 1',
                conn,
                params=(date_str, source),
            )
        else:
            df = pd.read_sql(
                'SELECT * FROM "WS_rice_price" WHERE Date = ? LIMIT 1',
                conn,
                params=(date_str,),
            )
        conn.close()
        if df.empty:
            return None
        return df.iloc[0].to_dict()
    except Exception:
        return None


def _sync_official_bulletin(
    bulletin_dt: datetime, latest_text: str, pdf_url: str
) -> bool:
    """Download and store the latest DA PDF bulletin (re-syncs incomplete rows)."""
    date_str = bulletin_dt.strftime("%m/%d/%Y")
    existing = _load_rice_row_from_db(date_str, SOURCE_OFFICIAL)
    if existing and _rice_filled_count(existing) >= len(TARGET_ORDER):
        logger.info("Official DA bulletin %s already complete in database.", date_str)
        return False
    if existing:
        logger.info(
            "Re-syncing incomplete official row for %s (%s/%s types).",
            date_str,
            _rice_filled_count(existing),
            len(TARGET_ORDER),
        )

    doc_name = latest_text or "DA_Price_Index.pdf"
    logger.info("Downloading official DA bulletin: %s", doc_name)
    pdf_bytes = download_binary(pdf_url)
    os.makedirs(DA_PDF_DIR, exist_ok=True)
    with open(
        os.path.join(DA_PDF_DIR, f"da_latest_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf"),
        "wb",
    ) as f:
        f.write(pdf_bytes)

    prices = extract_rice_prices_from_pdf_bytes(pdf_bytes)
    filled = sum(1 for key in TARGET_ORDER if prices.get(key) is not None)
    if filled == 0:
        logger.error(
            "Rice PDF downloaded but price extraction failed (0/%s fields).",
            len(TARGET_ORDER),
        )
        return False
    if filled < len(TARGET_ORDER):
        missing = [k for k in TARGET_ORDER if prices.get(k) is None]
        logger.warning(
            "Partial rice extraction (%s/%s); missing: %s",
            filled,
            len(TARGET_ORDER),
            ", ".join(missing),
        )

    # Sanity guard: a price that copies its neighbour grade or jumps far from the recent median is
    # held for review (Admin → Web Scraper) instead of going straight into the forecasts.
    try:
        prices, held = check_rice_row(date_str, prices, load_official_rice_history(DB_PATH))
        if held:
            queue(held)
            for h in held:
                logger.warning("HELD for review: %s %s = %.2f — %s", h["date"], h["column"], h["value"], h["reason"])
    except Exception as e:
        logger.warning("Rice sanity guard skipped: %s", e)

    row = {"Date": date_str, "Source": SOURCE_OFFICIAL}
    row.update(prices)
    _save_rice_row(row, "Official DA rice saved")
    return True


def _sync_estimated_through_today(last_official: date) -> bool:
    """
    Fill calendar days after the last official bulletin with computed estimates.
    Overwritten automatically when DA publishes the real bulletin for that day.
    """
    today = datetime.now().date()
    if last_official >= today:
        return False

    history = load_official_rice_history(DB_PATH)
    if history.empty:
        logger.warning("Cannot estimate rice — no official history in database.")
        return False

    saved = False
    cursor = last_official + timedelta(days=1)
    while cursor <= today:
        date_str = cursor.strftime("%m/%d/%Y")
        if _rice_row_for_date(date_str, SOURCE_OFFICIAL):
            cursor += timedelta(days=1)
            continue

        prices = estimate_rice_prices_for_date(cursor, history=history)
        if not prices:
            logger.warning("Estimate failed for %s — not enough official history.", date_str)
            break

        row = format_estimated_row(cursor, prices)
        _save_rice_row(
            row,
            "Estimated rice (temporary — will replace when DA posts bulletin)",
        )
        saved = True
        cursor += timedelta(days=1)

    return saved


def _has_published_rice_row(date_str: str) -> bool:
    """A row from DA itself (official or verified) — not an estimate — exists for this day."""
    if not os.path.exists(DB_PATH):
        return False
    try:
        conn = sqlite3.connect(DB_PATH)
        try:
            if _ws_rice_has_source_column(conn):
                row = conn.execute(
                    'SELECT 1 FROM "WS_rice_price" WHERE Date = ? AND COALESCE(Source, ?) != ? LIMIT 1',
                    (date_str, SOURCE_OFFICIAL, SOURCE_ESTIMATED),
                ).fetchone()
            else:
                row = conn.execute('SELECT 1 FROM "WS_rice_price" WHERE Date = ? LIMIT 1', (date_str,)).fetchone()
            return row is not None
        finally:
            conn.close()
    except Exception:
        return False


def backfill_rice_bulletins(days: int = CATCHUP_DAYS, candidates=None) -> List[str]:
    """Store every DA bulletin from the last `days` days that the database has no DA row for.

    The regular cycle only reads the newest bulletin, so a day the scraper did not run was lost, or
    kept its temporary estimate. Days that already hold a DA row (official or verified) are never
    touched. Returns the dates written (MM/DD/YYYY).
    """
    if candidates is None:
        candidates = list_da_pdfs()
    oldest = datetime.now() - timedelta(days=days)
    written: List[str] = []
    for dt, text, url in sorted((c for c in candidates if c[0] is not None), key=lambda c: c[0]):
        if dt < oldest:
            continue
        date_str = dt.strftime("%m/%d/%Y")
        if _has_published_rice_row(date_str):
            continue
        try:
            if _sync_official_bulletin(dt, text, url):
                written.append(date_str)
        except Exception as e:
            logger.warning("Catch-up: DA bulletin %s could not be read: %s", date_str, e)
    if written:
        logger.info("Catch-up: stored %s missed DA bulletin(s): %s", len(written), ", ".join(written))
    return written


def fetch_rice_prices() -> bool:
    try:
        latest_dt, latest_text, pdf_url = choose_latest_da_pdf()
        if not pdf_url:
            logger.error("Could not find the DA Daily Price Index PDF link.")
            return False

        bulletin_dt = latest_dt or datetime.now()
        doc_name = latest_text or "DA_Price_Index.pdf"
        logger.info("DA rice bulletin: %s (%s)", doc_name, pdf_url)

        calendar_today = datetime.now().date()
        if bulletin_dt.date() < calendar_today:
            logger.info(
                "Walang %s na Daily Price Index sa DA.gov.ph — "
                "pinakabagong bulletin: %s. Gagamit ng temporary estimate hanggang ma-post ang DA.",
                datetime.now().strftime("%m/%d/%Y"),
                bulletin_dt.strftime("%m/%d/%Y"),
            )

        official_saved = _sync_official_bulletin(bulletin_dt, latest_text, pdf_url)
        caught_up = backfill_rice_bulletins()
        estimate_saved = _sync_estimated_through_today(bulletin_dt.date())

        if official_saved or caught_up or estimate_saved:
            return True

        today_str = calendar_today.strftime("%m/%d/%Y")
        if _rice_row_for_date(today_str):
            logger.info("Rice data up to date for %s (official and/or estimate).", today_str)
            return True

        logger.error("No rice data saved — official scrape and estimate both skipped.")
        return False
    except Exception as e:
        logger.error("Rice price fetch failed: %s", e)
        return False


def fetch_exchange_rates() -> bool:
    try:
        resp = SESSION.get(RATE_URL, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
        if data.get("result") != "success":
            raise RuntimeError(f"Unexpected API result: {data.get('result')}")

        usd_to_php = float(data["rates"]["PHP"])
        usd_to_thb = float(data["rates"]["THB"])
        usd_to_vnd = float(data["rates"]["VND"])
        row = {
            "Date": formatted_today(),
            "USD_to_PHP": round(usd_to_php, 4),
            "THB_to_PHP": round(usd_to_php / usd_to_thb, 4),
            "VND_to_PHP": round(usd_to_php / usd_to_vnd, 6),
            "Source": SOURCE_RATE_LIVE,
        }
        upsert_csv(RATE_CSV, row)
        upsert_sqlite("WS_currency", row)
        logger.info(f"SUCCESSFULLY SCRAPED EXCHANGE RATES ({datetime.now().strftime('%Y-%m-%d')})")
        ok = True
    except Exception as e:
        logger.error("Exchange rate fetch failed: %s", e)
        ok = False
    try:
        ok = bool(backfill_exchange_rates()) or ok
    except Exception as e:
        logger.warning("Catch-up: exchange-rate backfill failed: %s", e)
    return ok


def fetch_rate_for_day(day: date) -> Optional[Dict]:
    """USD/PHP (plus THB and VND in PHP) for one past day from the dated archive, or None."""
    rates: Dict = {}
    for url in (RATE_HISTORY_URL, RATE_HISTORY_MIRROR):
        try:
            resp = SESSION.get(url.format(day=day.isoformat()), timeout=REQUEST_TIMEOUT)
            if resp.ok:
                rates = (resp.json() or {}).get("usd") or {}
                if rates:
                    break
        except Exception as e:
            logger.debug("Rate archive %s for %s: %s", url, day, e)
    if not rates:
        return None
    php, thb, vnd = rates.get("php"), rates.get("thb"), rates.get("vnd")
    if not php or not (RATE_MIN_PHP <= float(php) <= RATE_MAX_PHP):
        logger.warning("Catch-up: USD/PHP for %s looks wrong (%s) — skipped", day, php)
        return None
    php = float(php)
    return {
        "Date": day.strftime("%m/%d/%Y"),
        "USD_to_PHP": round(php, 4),
        "THB_to_PHP": round(php / float(thb), 4) if thb else None,
        "VND_to_PHP": round(php / float(vnd), 6) if vnd else None,
        "Source": SOURCE_RATE_HISTORY,
    }


def backfill_exchange_rates(days: int = CATCHUP_DAYS, since: Optional[date] = None) -> List[str]:
    """Fill every day without a USD/PHP row, from `since` (default: `days` ago) up to yesterday.

    Only empty days are written; a stored rate is never replaced. Returns the dates written.
    """
    today = datetime.now().date()
    start = since or (today - timedelta(days=days))
    have = set()
    if os.path.exists(DB_PATH):
        conn = sqlite3.connect(DB_PATH)
        try:
            have = {
                d.date() for d in pd.to_datetime(
                    pd.read_sql('SELECT Date FROM "WS_currency" WHERE USD_to_PHP IS NOT NULL', conn)["Date"],
                    errors="coerce", format="mixed",
                ).dropna()
            }
        except Exception:
            have = set()
        finally:
            conn.close()
    written: List[str] = []
    day = start
    while day < today:
        if day not in have:
            try:
                row = fetch_rate_for_day(day)
            except Exception as e:
                logger.warning("Catch-up: no archived rate for %s (%s)", day, e)
                row = None
            if row:
                upsert_csv(RATE_CSV, row)
                upsert_sqlite("WS_currency", row)
                written.append(row["Date"])
        day += timedelta(days=1)
    if written:
        logger.info("Catch-up: filled %s missed USD/PHP day(s): %s .. %s", len(written), written[0], written[-1])
    return written


# ── Rice import tariff (EO 105 s.2025 / IAGRTA Circular 2025-001) ──────────────────────────────
# "Other" milled rice, Out-Quota — the general commercial import line, not a named specialty
# variety (Basmati/glutinous/Hom Mali/etc.), matching this app's Imported Well-Milled/Regular/
# Premium/Special categories. Resolved by AHTN code via /item_search rather than a hardcoded
# numeric item id, since that id is the Tariff Commission's own internal database key and isn't
# guaranteed stable across their data releases. Confirmed by hand (2026-09-24) that the MFN rate
# on this line and on rice-in-husk both read "15 /l" with the identical IAGRTA footnote — the
# EO 105 rate applies uniformly across the rice heading, not per sub-line.
TARIFF_AHTN_CODE = "1006.30.99.200"
TARIFF_MFN_AGREEMENT_CODE = "MFN"


def _current_quarter_start(d: Optional[date] = None) -> Tuple[date, str]:
    d = d or datetime.now().date()
    q = (d.month - 1) // 3 + 1
    return date(d.year, 3 * (q - 1) + 1, 1), f"Q{q} {d.year}"


def _resolve_tariff_item_id(code: str) -> Optional[int]:
    resp = SESSION.get(
        f"{TARIFF_FINDER_URL}/item_search", params={"search": code}, timeout=REQUEST_TIMEOUT
    )
    resp.raise_for_status()
    for item in resp.json().get("data", []):
        if item.get("code") == code:
            return item.get("id")
    return None


def fetch_tariff_rate() -> bool:
    """Watches the Tariff Commission's own Philippine Tariff Finder for the current MFN rice
    import tariff and stages it in `tariff_schedule` for admin review — it never publishes a rate
    on its own. Unlike rice/fuel/currency, this number carries real legal weight (it sets a
    national import duty) and feeds the public consumer-price calculator, and it changes at most
    quarterly, so the payoff of full automation is low next to the cost of a bad number going
    live unattended. This function only ever proposes a candidate via
    add_scraped_tariff_candidate(); an admin must open the linked Tariff Finder page and click
    Activate on the Taxes & Import Charges page before it can affect anything.
    """
    if add_scraped_tariff_candidate is None:
        logger.error("Tariff fetch skipped — api/catalog_service.py not importable.")
        return False
    try:
        item_id = _resolve_tariff_item_id(TARIFF_AHTN_CODE)
        if item_id is None:
            logger.error("Tariff Finder: could not resolve AHTN code %s to an item id.", TARIFF_AHTN_CODE)
            return False

        year = datetime.now().year
        resp = SESSION.get(
            f"{TARIFF_FINDER_URL}/rate-pivot",
            params={"item": item_id, "years": year, "fta": 1},  # fta=1 == MFN in their agreement table
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        mfn_row = next(
            (r for r in rows if (r.get("agreement") or {}).get("code") == TARIFF_MFN_AGREEMENT_CODE),
            None,
        )
        if not mfn_row:
            logger.error("Tariff Finder: no MFN row for item %s, year %s.", item_id, year)
            return False

        raw_rate = str(mfn_row.get("rate") or "")
        match = re.match(r"\s*([\d.]+)", raw_rate)
        if not match:
            logger.error("Tariff Finder: could not parse a numeric rate from %r.", raw_rate)
            return False
        rate_pct = float(match.group(1))
        if not (TARIFF_BAND_MIN <= rate_pct <= TARIFF_BAND_MAX):
            logger.error(
                "Tariff Finder: parsed rate %.1f%% is outside the legal %.0f-%.0f%% band — "
                "refusing to stage (likely a parsing mistake, not a real rate).",
                rate_pct, TARIFF_BAND_MIN, TARIFF_BAND_MAX,
            )
            return False

        footnotes = mfn_row.get("producttarifffootnotes") or []
        foot_desc = (footnotes[0].get("foots") or {}).get("foot_desc") if footnotes else ""

        quarter_start, quarter_label = _current_quarter_start()
        source_url = f"{TARIFF_FINDER_URL}/search-by-code"

        result = add_scraped_tariff_candidate(
            rate_pct=rate_pct,
            effective_start=quarter_start.isoformat(),
            quarter_label=quarter_label,
            legal_basis=foot_desc or "EO 105 s.2025 / IAGRTA Circular No. 2025-001",
            da_certification_url=source_url,
            source=f"Philippine Tariff Finder (Tariff Commission) — AHTN {TARIFF_AHTN_CODE}, MFN",
        )
        if result.get("ok"):
            logger.info(
                "Tariff Finder: staged %s @ %.1f%% for admin review (id %s).",
                quarter_label, rate_pct, result.get("id"),
            )
            return True
        if result.get("duplicate"):
            logger.info(
                "Tariff Finder: %s already has a tariff row (id %s) — nothing new to stage.",
                quarter_label, result.get("id"),
            )
            return True
        logger.error("Tariff Finder: could not stage candidate — %s", result.get("error"))
        return False
    except Exception as e:
        logger.error("Tariff rate fetch failed: %s", e)
        return False


# Plausible PH pump-price band, PHP/litre. DOE's own NCR bulletins reach PHP 153.70 (diesel, week of
# 2026-04-07), so the upper bound must sit above that. (It used to be 110, set when the 2026 spike was
# wrongly believed to be a Zigwheels mis-parse — the DOE PDFs show it was real.)
FUEL_MIN_PHP = 15.0
FUEL_MAX_PHP = 250.0
# If the newest DOE week is older than this, DOE has stopped publishing (or its page changed): use the
# GasWatch PH fallback for the current week instead of silently re-serving an old price.
DOE_STALE_DAYS = 14


def fetch_fuel_prices() -> bool:
    """Weekly NCR pump prices from the DOE bulletin (official), GasWatch PH as fallback.

    Replaces the Zigwheels scraper: that page kept a fresh "Last updated" date while its prices stayed
    frozen at RON95 PHP 58.15 / Diesel PHP 56.74 from 2026-05-28 on (DOE: PHP 96.20 / 103.30 for
    Sep 22-28, 2026). One WS_fuel row per DOE week (every week DOE publishes, Dec 2024 onward), dated
    the week's first day. A product DOE prints as "#N/A" takes GasWatch PH's figure for the same week
    when it has one (listed in the row's "Filled" column), otherwise stays empty; nothing is estimated.
    """
    import doe_fuel

    try:
        weeks = doe_fuel.fetch_doe_weeks()
        # A product DOE printed as "#N/A" takes GasWatch PH's figure for the same week, flagged in "Filled".
        weeks = doe_fuel.fill_blanks_from_gaswatch(weeks, doe_fuel.load_gaswatch())
        for w in weeks:
            for k in ("RON_95", "RON_91", "RON_97", "Diesel", "Diesel_Plus", "Kerosene"):
                v = w.get(k)
                if v is not None and not (FUEL_MIN_PHP <= v <= FUEL_MAX_PHP):
                    logger.warning("Fuel (DOE %s): %s = %.2f outside PHP %.0f-%.0f, left empty",
                                   w["week_start"], k, v, FUEL_MIN_PHP, FUEL_MAX_PHP)
                    w[k] = None
        if weeks:
            latest = weeks[-1]
            # Only write weeks not already stored from DOE, plus the latest (DOE sometimes re-uploads).
            for w in weeks:
                upsert_sqlite("WS_fuel", doe_fuel.to_ws_fuel_row(w, doe_fuel.SOURCE_DOE))
            upsert_csv(FUEL_CSV, doe_fuel.to_ws_fuel_row(latest, doe_fuel.SOURCE_DOE))
            logger.info("Fuel (DOE NCR, week of %s): RON95 %.2f, Diesel %.2f",
                        latest["week_label"], latest.get("RON_95") or 0, latest.get("Diesel") or 0)
            if (date.today() - latest["week_start"]).days <= DOE_STALE_DAYS:
                logger.info(f"SUCCESSFULLY SCRAPED FUEL DATA ({datetime.now().strftime('%Y-%m-%d')})")
                return True
            logger.warning("Fuel: newest DOE week (%s) is over %s days old — trying GasWatch PH.",
                           latest["week_start"], DOE_STALE_DAYS)
        else:
            logger.warning("Fuel: no DOE NCR bulletin could be read — trying GasWatch PH.")
    except Exception as e:
        logger.warning("Fuel: DOE fetch failed (%s) — trying GasWatch PH.", e)

    try:
        gw = doe_fuel.fetch_gaswatch_week()
        if not gw or gw.get("Diesel") is None:
            raise RuntimeError("GasWatch PH data file had no weekly averages.")
        row = doe_fuel.to_ws_fuel_row(gw, doe_fuel.SOURCE_GASWATCH)
        upsert_sqlite("WS_fuel", row)
        upsert_csv(FUEL_CSV, row)
        logger.info("Fuel (GasWatch PH fallback, week of %s): RON95 %.2f, Diesel %.2f",
                    gw["week_start"], gw.get("RON_95") or 0, gw["Diesel"])
        return True
    except Exception as e:
        logger.error("Fuel price fetch failed (DOE and GasWatch PH): %s", e)
        return False


def fetch_psa_monthly() -> bool:
    """Monthly national rice stocks inventory and palay farmgate price from PSA OpenSTAT (tools/psa_openstat.py).

    Refreshes the whole 2015-onward series each run, because PSA revises past months. A refresh that looks
    wrong (fewer months than already stored, or a value outside a plausible band) is refused and the stored
    copy kept, so a PSA outage or a partial response can never shrink or corrupt the model's inputs.
    """
    import psa_openstat as psa

    try:
        stocks = psa.fetch_rice_stocks(2015)
        farmgate = psa.fetch_palay_farmgate(2015)
        conn = sqlite3.connect(DB_PATH)
        try:
            existing, before = {}, {}
            for name in ("PSA_rice_stocks", "PSA_farmgate"):
                try:
                    old = pd.read_sql(f'SELECT * FROM "{name}"', conn)
                    existing[name] = len(old)
                    before[name] = old
                except Exception:
                    existing[name] = 0
            problems = psa.validate(stocks, farmgate, existing)
            if problems:
                for p in problems:
                    logger.error("PSA refresh refused: %s", p)
                return False
            psa.write_tables(conn, stocks, farmgate)
        finally:
            conn.close()

        # Report what changed: new months and months PSA revised since the last refresh.
        for name, df, col in (("PSA_rice_stocks", stocks, "total"), ("PSA_farmgate", farmgate, "other_variety")):
            old = before.get(name)
            new_months, revised = len(df), 0
            if old is not None and not old.empty:
                o = old.set_index(pd.to_datetime(old["Date"]))[col]
                n = df.set_index("Date")[col]
                new_months = int((~n.index.isin(o.index)).sum())
                common = n.index.intersection(o.index)
                revised = int((n.loc[common].round(2) != o.loc[common].round(2)).sum())
            logger.info("PSA %s: latest %s, %s new month(s), %s revised", name, psa.latest_months(df), new_months, revised)
        logger.info(f"SUCCESSFULLY FETCHED PSA MONTHLY DATA ({datetime.now().strftime('%Y-%m-%d')})")
        return True
    except Exception as e:
        logger.error("PSA OpenSTAT fetch failed: %s", e)
        return False


def _refresh_macro(table: str, label: str) -> bool:
    """One monthly economic factor (tools/macro_factors.py), its own scrape step since 2026-10-07. A refresh that
    looks wrong is refused and the stored copy kept."""
    import macro_factors as mf

    try:
        conn = sqlite3.connect(DB_PATH)
        try:
            ok, problems = mf.refresh(conn, [table])
            latest = conn.execute(f'SELECT MAX(Date), COUNT(*) FROM "{table}"').fetchone() if ok else None
        finally:
            conn.close()
        for p in problems:
            logger.error("%s refresh refused: %s", label, p)
        if ok:
            logger.info("SUCCESSFULLY FETCHED %s — latest month %s, %s months stored", label.upper(), str(latest[0])[:7], latest[1])
        return ok
    except Exception as e:
        logger.error("%s fetch failed: %s", label, e)
        return False


def fetch_core_inflation() -> bool:
    """PSA OpenSTAT core inflation (year-on-year %, monthly, 2015 onward) -> MACRO_core_inflation."""
    return _refresh_macro("MACRO_core_inflation", "PSA core inflation")


def fetch_world_rice() -> bool:
    """World Bank Pink Sheet, Rice Viet Namese 5% (USD/t, monthly, 2015 onward) -> MACRO_world_rice."""
    return _refresh_macro("MACRO_world_rice", "World Bank rice price")


def refresh_macro_factors() -> bool:
    """Both monthly economic factors (kept for callers that refresh them together)."""
    a, b = fetch_core_inflation(), fetch_world_rice()
    return a and b


def run_cycle() -> bool:
    logger.info("Starting scrape cycle...")
    rice_ok = fetch_rice_prices()
    rate_ok = fetch_exchange_rates()
    fuel_ok = fetch_fuel_prices()
    tariff_ok = fetch_tariff_rate()
    psa_ok = fetch_psa_monthly()
    cpi_ok = fetch_core_inflation()
    wb_ok = fetch_world_rice()
    ok = rice_ok or rate_ok or fuel_ok or tariff_ok or psa_ok or cpi_ok or wb_ok
    if ok:
        logger.info("Cycle finished.")
    else:
        logger.warning("Cycle finished with no successful dataset updates.")
    return ok


def loop_forever(interval_seconds: int = DEFAULT_INTERVAL_SECONDS) -> None:
    interval_seconds = max(60, int(interval_seconds))
    logger.info("Continuous mode enabled. Interval: %s second(s).", interval_seconds)
    while True:
        start = time.time()
        try:
            run_cycle()
        except KeyboardInterrupt:
            raise
        except Exception as e:
            logger.exception("Unexpected loop error: %s", e)
        elapsed = time.time() - start
        sleep_for = max(60, int(interval_seconds - elapsed))
        logger.info("Sleeping for %s second(s)...", sleep_for)
        time.sleep(sleep_for)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="AgriPrice daily scraper")
    parser.add_argument("--once", action="store_true", help="Run one cycle only")
    parser.add_argument(
        "--interval",
        type=int,
        default=DEFAULT_INTERVAL_SECONDS,
        help=f"Loop interval in seconds. Default is {DEFAULT_INTERVAL_SECONDS}.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.once:
        return 0 if run_cycle() else 1
    loop_forever(args.interval)
    return 0


if __name__ == "__main__":
    sys.exit(main())

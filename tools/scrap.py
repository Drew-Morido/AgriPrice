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
FUEL_URL = "https://www.zigwheels.ph/fuel-price"
RATE_URL = "https://open.er-api.com/v6/latest/USD"

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# Aakyat tayo ng isang folder (papuntang AGRIPRICEPH V3 root)
PROJECT_ROOT = os.path.dirname(BASE_DIR)

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


def choose_latest_da_pdf() -> Tuple[Optional[datetime], Optional[str], Optional[str]]:
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

    if not candidates:
        return None, None, None

    dated = [item for item in candidates if item[0] is not None]
    if not dated:
        first = candidates[0]
        return first[0], first[1], first[2]

    dated.sort(key=lambda item: item[0], reverse=True)
    return dated[0]


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
    with open(
        os.path.join(DEBUG_DIR, f"da_latest_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf"),
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
        estimate_saved = _sync_estimated_through_today(bulletin_dt.date())

        if official_saved or estimate_saved:
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
        }
        upsert_csv(RATE_CSV, row)
        upsert_sqlite("WS_currency", row)
        logger.info(f"SUCCESSFULLY SCRAPED EXCHANGE RATES ({datetime.now().strftime('%Y-%m-%d')})")
        return True
    except Exception as e:
        logger.error("Exchange rate fetch failed: %s", e)
        return False


def _clean_text_lines(html: str) -> List[str]:
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text("\n", strip=True)
    lines: List[str] = []
    for raw in text.splitlines():
        line = re.sub(r"\s+", " ", raw).strip()
        if line:
            lines.append(line)
    return lines


def _extract_price_after_label(text: str, label: str) -> Optional[float]:
    pattern = rf"{re.escape(label)}[^0-9]{{0,12}}(?:₱\s*)?(\d{{1,3}}\.\d{{1,2}})"
    match = re.search(pattern, text, flags=re.IGNORECASE)
    if not match:
        return None
    return float(match.group(1))


_FUEL_LABELS = {
    "Gasoline": ("Gasoline",),
    "RON_100": ("RON 100",),
    "RON_97": ("RON 97",),
    "RON_95": ("RON 95",),
    "RON_91": ("RON 91",),
    "Diesel": ("Diesel",),
    "Diesel_Plus": ("Diesel Plus",),
    "Kerosene": ("Kerosene",),
}


# Plausible PH pump-price band, PHP/litre. The DOE historical series spans 18.40-103.95
# (the upper end is the real mid-2022 spike), so this is wide enough to keep every genuine
# reading while rejecting a mis-parse.
FUEL_MIN_PHP = 15.0
FUEL_MAX_PHP = 110.0


def _parse_fuel_table(html: str) -> Dict[str, float]:
    """Parse Zigwheels fuel prices for Manila.

    Two tables on the page match `.fuel-price-table`: the labelled Manila summary
    (`.fuel-rates`) and a per-city table whose first column is a CITY name. Iterating both
    indiscriminately is what produced the 2026-03-10..05-27 corruption in `WS_fuel`
    (Gasoline ~PHP 72-96, Diesel ~PHP 82-129 — roughly double reality) with RON_100/RON_91/
    Diesel_Plus left NaN and Gasoline == RON_95, a degenerate partial parse that
    `_fill_missing_fuel_fields()` then back-filled and hid.

    So: read the labelled summary first, then use the city table's own "Manila" row (which
    carries all six columns) as a fallback/cross-check.
    """
    soup = BeautifulSoup(html, "html.parser")
    row: Dict[str, float] = {}

    def _price_from_cell(text: str) -> Optional[float]:
        match = re.search(r"(\d{1,3}\.\d{1,2})", text.replace(",", ""))
        return float(match.group(1)) if match else None

    # ── 1. labelled Manila summary table ────────────────────────────────────────────────
    for table in soup.select("table.fuel-rates"):
        for tr in table.find_all("tr"):
            cells = [c.get_text(" ", strip=True) for c in tr.find_all(["td", "th"])]
            if len(cells) < 2:
                continue
            norm = re.sub(r"\s+", " ", cells[0]).strip().lower()
            price = _price_from_cell(cells[1])
            if price is None:
                continue
            for key, aliases in _FUEL_LABELS.items():
                if any(norm == alias.lower() for alias in aliases):
                    row[key] = price
                    break

    # ── 2. per-city table: take the Manila row by header position ───────────────────────
    for table in soup.select("table.fuel-price-table"):
        header = None
        for tr in table.find_all("tr"):
            cells = [c.get_text(" ", strip=True) for c in tr.find_all(["td", "th"])]
            if not cells:
                continue
            if header is None:
                if re.sub(r"\s+", " ", cells[0]).strip().lower() == "city":
                    header = [re.sub(r"\s+", " ", c).strip().lower() for c in cells]
                continue
            if re.sub(r"\s+", " ", cells[0]).strip().lower() != "manila":
                continue
            for key, aliases in _FUEL_LABELS.items():
                for alias in aliases:
                    if alias.lower() in header:
                        idx = header.index(alias.lower())
                        if idx < len(cells):
                            price = _price_from_cell(cells[idx])
                            if price is not None:
                                row.setdefault(key, price)
                        break

    return _validated_fuel_row(row)


def _validated_fuel_row(row: Dict[str, float]) -> Dict[str, float]:
    """Drop implausible values and reject a whole scrape that looks like a degenerate parse.

    Returning {} makes the caller keep the previous good reading instead of writing garbage.
    """
    clean = {
        k: v for k, v in row.items()
        if isinstance(v, (int, float)) and FUEL_MIN_PHP <= float(v) <= FUEL_MAX_PHP
    }
    dropped = set(row) - set(clean)
    if dropped:
        logger.warning("Fuel: dropped out-of-range field(s) %s from %s", sorted(dropped), row)

    # Degenerate-parse signature seen in the 2026 corruption: only the three "headline" fields
    # came back AND gasoline equals RON 95 (they differ by ~PHP 4 on a healthy parse).
    core = {"Gasoline", "RON_95", "Diesel"}
    if core.issubset(clean) and len(clean) <= 3 and clean["Gasoline"] == clean["RON_95"]:
        logger.error(
            "Fuel: rejecting scrape — degenerate parse (only %s, Gasoline == RON 95 == %.2f). "
            "Keeping previous reading.", sorted(clean), clean["Gasoline"],
        )
        return {}

    # Ordering sanity when the octane grades are present.
    if {"RON_100", "RON_95"}.issubset(clean) and clean["RON_100"] < clean["RON_95"]:
        logger.warning("Fuel: RON 100 (%.2f) < RON 95 (%.2f) — suspicious parse.",
                       clean["RON_100"], clean["RON_95"])
    return clean


def _fill_missing_fuel_fields(row: Dict[str, float]) -> None:
    """
    Zigwheels Manila lists 6 fuel types (no RON 97 / Kerosene on page).
    Fill gaps from last CSV row, then sensible defaults from scraped siblings.
    """
    if os.path.exists(FUEL_CSV):
        try:
            hist = pd.read_csv(FUEL_CSV)
            if not hist.empty:
                hist["_sort"] = pd.to_datetime(hist["Date"], errors="coerce")
                hist = hist.sort_values("_sort")
                prev = hist.iloc[-1].to_dict()
                for key in _FUEL_LABELS:
                    if key not in row and key in prev and pd.notna(prev[key]):
                        row[key] = float(prev[key])
        except Exception:
            pass

    if "RON_97" not in row and "RON_95" in row and "RON_100" in row:
        row["RON_97"] = round((row["RON_95"] + row["RON_100"]) / 2, 2)
        logger.info("RON_97 not on Zigwheels — using average of RON 95 and RON 100.")

    if "Kerosene" not in row:
        if "Diesel" in row:
            row["Kerosene"] = row["Diesel"]
            logger.info("Kerosene not on Zigwheels — using Diesel price as proxy.")
        elif "RON_91" in row:
            row["Kerosene"] = row["RON_91"]
            logger.info("Kerosene not on Zigwheels — using RON 91 price as proxy.")


def fetch_fuel_prices() -> bool:
    try:
        resp = SESSION.get(FUEL_URL, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        html = resp.text
        save_debug_file("zigwheels_fuel.html", html)

        row: Dict[str, float] = {"Date": formatted_today()}
        row.update(_parse_fuel_table(html))

        if not row.get("Gasoline"):
            lines = _clean_text_lines(html)
            joined = "\n".join(lines)
            for key, aliases in _FUEL_LABELS.items():
                if key in row:
                    continue
                for label in aliases:
                    price = _extract_price_after_label(joined, label)
                    if price is not None:
                        row[key] = price
                        break

        if not row.get("Gasoline"):
            raise RuntimeError("No fuel prices found on the page.")

        _fill_missing_fuel_fields(row)
        found = sum(1 for key in _FUEL_LABELS if key in row)
        logger.info("Fuel fields captured: %s/%s", found, len(_FUEL_LABELS))

        upsert_csv(FUEL_CSV, row)
        upsert_sqlite("WS_fuel", row)
        logger.info(f"SUCCESSFULLY SCRAPED FUEL DATA ({datetime.now().strftime('%Y-%m-%d')})")
        return True
    except Exception as e:
        logger.error("Fuel price fetch failed: %s", e)
        return False


def run_cycle() -> bool:
    logger.info("Starting scrape cycle...")
    rice_ok = fetch_rice_prices()
    rate_ok = fetch_exchange_rates()
    fuel_ok = fetch_fuel_prices()
    ok = rice_ok or rate_ok or fuel_ok
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

"""
Temporary rice price estimates when DA.gov.ph has not published today's bulletin.
Replaced automatically once an official PDF row is scraped for the same date.
"""

from __future__ import annotations

import os
import sqlite3
from datetime import date, datetime
from typing import Dict, Optional

import pandas as pd

from pdfconvrt import TARGET_ORDER

SOURCE_OFFICIAL = "da_official"
SOURCE_ESTIMATED = "estimated"

LOOKBACK_DAYS = 7
MIN_HISTORY_ROWS = 2
MIN_FILLED_TYPES = 4
PRICE_MIN = 30.0
PRICE_MAX = 80.0


def _db_path() -> str:
    base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(os.path.dirname(base), "datasets", "agriprice_database.db")


def _parse_dates(series: pd.Series) -> pd.Series:
    s = series.astype(str).str.strip()
    parsed = pd.to_datetime(s, format="%m/%d/%Y", errors="coerce")
    missing = parsed.isna()
    if missing.any():
        parsed.loc[missing] = pd.to_datetime(s[missing], errors="coerce")
    return parsed


def load_official_rice_history(db_path: Optional[str] = None) -> pd.DataFrame:
    """Official DA rows only (excludes previous estimates)."""
    path = db_path or _db_path()
    if not os.path.exists(path):
        return pd.DataFrame()

    conn = sqlite3.connect(path)
    try:
        df = pd.read_sql('SELECT * FROM "WS_rice_price"', conn)
    except Exception:
        df = pd.DataFrame()
    finally:
        conn.close()

    if df.empty:
        return df

    if "Source" not in df.columns:
        df["Source"] = SOURCE_OFFICIAL
    else:
        df["Source"] = df["Source"].fillna(SOURCE_OFFICIAL).astype(str)

    df = df[df["Source"] != SOURCE_ESTIMATED].copy()
    df["_date"] = _parse_dates(df["Date"])
    df = df.dropna(subset=["_date"]).sort_values("_date")
    return df


def estimate_rice_prices_for_date(
    target: date,
    history: Optional[pd.DataFrame] = None,
) -> Dict[str, float]:
    """
    Project each rice type using the mean daily change over recent official bulletins.
    """
    hist = history if history is not None else load_official_rice_history()
    if hist.empty or len(hist) < MIN_HISTORY_ROWS:
        return {}

    results: Dict[str, float] = {}
    for col in TARGET_ORDER:
        if col not in hist.columns:
            continue
        series = hist[["_date", col]].copy()
        series[col] = pd.to_numeric(series[col], errors="coerce")
        series = series.dropna(subset=[col])
        if series.empty:
            continue

        tail = series.tail(LOOKBACK_DAYS)
        last_row = tail.iloc[-1]
        last_date = last_row["_date"].date()
        last_val = float(last_row[col])

        if len(tail) >= 2:
            deltas = tail[col].diff().dropna()
            mean_delta = float(deltas.mean()) if len(deltas) else 0.0
        else:
            mean_delta = 0.0

        days_ahead = max(0, (target - last_date).days)
        est = last_val + mean_delta * days_ahead
        est = round(max(PRICE_MIN, min(PRICE_MAX, est)), 2)
        results[col] = est

    if len(results) < MIN_FILLED_TYPES:
        return {}
    return results


def format_row(target: date, prices: Dict[str, float]) -> Dict:
    return {
        "Date": target.strftime("%m/%d/%Y"),
        "Source": SOURCE_ESTIMATED,
        **prices,
    }

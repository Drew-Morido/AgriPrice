"""
Temporary rice price estimates when DA.gov.ph has not published today's bulletin.
Replaced automatically once an official PDF row is scraped for the same date. For display only: the
forecasting model never reads an estimated row (see model/data_pipeline.py, data readiness checklist).
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


# WS_rice_price column -> forecast key used by model/predict.py
_FORECAST_KEY = {
    "Local Special": "locSpecial", "Local Premium": "locPremium",
    "Local Well Milled": "locWellMilled", "Local Regular Milled": "locRegular",
    "Imported Special": "impSpecial", "Imported Premium": "impPremium",
    "Imported Well Milled": "impWellMilled", "Imported Regular Milled": "impRegular",
}
_FORECAST_CACHE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                               "model", "forecast_cache.json")


def _published_forecast_for(target: date) -> Dict[str, float]:
    """The system's own published forecast for `target` (model/forecast_cache.json), per rice column."""
    import json
    try:
        with open(_FORECAST_CACHE, encoding="utf-8") as f:
            payload = json.load(f).get("payload") or {}
    except (OSError, ValueError):
        return {}
    out: Dict[str, float] = {}
    iso = target.isoformat()
    for col, key in _FORECAST_KEY.items():
        for day in (payload.get("forecasts_by_key") or {}).get(key) or []:
            if day.get("date_iso") == iso and day.get("price") is not None:
                out[col] = float(day["price"])
    return out


def estimate_rice_prices_for_date(
    target: date,
    history: Optional[pd.DataFrame] = None,
) -> Dict[str, float]:
    """Temporary price for a day DA has not published yet. Display only — the model never uses it
    (model/data_pipeline.py drops Source='estimated' rows).

    Uses the system's published forecast for that date when one exists, else the last official price.
    It used to extend the mean daily change of the last 7 bulletins. Measured on the 2026 daily bulletins
    (1,936 day-ahead cases, 8 types), that trend made the estimate WORSE than simply repeating the last
    price: MAE PHP 0.258 vs 0.228 (-13%). A 30-day trend was still worse (0.237, -4%), because daily rice
    prices mean-revert. The published forecast is the ensemble, measured about 10% better than the last
    price on the test window.
    """
    hist = history if history is not None else load_official_rice_history()
    if hist.empty or len(hist) < MIN_HISTORY_ROWS:
        return {}

    forecast = _published_forecast_for(target)
    results: Dict[str, float] = {}
    for col in TARGET_ORDER:
        if col in forecast:
            est = forecast[col]
        else:
            if col not in hist.columns:
                continue
            series = pd.to_numeric(hist[col], errors="coerce").dropna()
            if series.empty:
                continue
            est = float(series.iloc[-1])
        results[col] = round(max(PRICE_MIN, min(PRICE_MAX, est)), 2)

    if len(results) < MIN_FILLED_TYPES:
        return {}
    return results


def format_row(target: date, prices: Dict[str, float]) -> Dict:
    return {
        "Date": target.strftime("%m/%d/%Y"),
        "Source": SOURCE_ESTIMATED,
        **prices,
    }

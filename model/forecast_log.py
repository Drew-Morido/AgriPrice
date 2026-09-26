"""Forward (prospective) evaluation: log each day's published forecasts, score them once prices arrive.

Why: every accuracy figure in meta.json comes from a held-out test window that was reused across many
experiments (PAPER_CORRECTIONS.md). The clean confirmation is a forecast written down BEFORE the DA price for
its day existed, then compared with that price. This module does exactly that and nothing else:

  - log_payload(payload): called when a fresh forecast payload is built (predict.py). One row per rice type and
    forecast day, keyed (origin_date, rice_type, target_date). INSERT OR IGNORE keeps the first forecast ever
    made for that key, so a later rebuild can never overwrite it. The origin is the last day with data; the
    target date is origin + h (the day the model actually forecasts).
  - score(): joins logged rows with the prices that have since been observed and reports, per forecast day and
    per rice type: ensemble MAE, the naive "same as the origin day" MAE, skill, ARIMA and hybrid MAE (logged
    alongside as components), price-range coverage, and direction on non-steady calls.

Run a report:  cd model && py -3.13 forecast_log.py        (also served at GET /api/forecast-check)
"""

from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timedelta

import numpy as np
import pandas as pd

MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(os.path.dirname(MODEL_DIR), "datasets", "agriprice_database.db")
STEADY_PESO = float(os.environ.get("AGRIPRICE_STEADY_PESO", "0.10"))

_SCHEMA = """
CREATE TABLE IF NOT EXISTS forecast_log (
    origin_date   TEXT NOT NULL,     -- last day with a DA price when the forecast was made (YYYY-MM-DD)
    rice_type     TEXT NOT NULL,
    horizon       INTEGER NOT NULL,  -- 1..3 days after the origin
    target_date   TEXT NOT NULL,     -- origin_date + horizon: the day being forecast
    origin_price  REAL,              -- the last known price (the naive forecast)
    forecast      REAL NOT NULL,     -- the published forecast
    low           REAL,
    high          REAL,
    direction     TEXT,
    model         TEXT,
    comp_hybrid   REAL,              -- ensemble components, logged for a like-for-like forward comparison
    comp_arima    REAL,
    comp_kalman   REAL,
    logged_at     TEXT NOT NULL,
    PRIMARY KEY (origin_date, rice_type, target_date)
)
"""


def _connect(db_path: str = DB_PATH):
    con = sqlite3.connect(db_path)
    con.execute(_SCHEMA)
    return con


def log_payload(payload: dict, db_path: str = DB_PATH) -> int:
    """Store the forecasts in a freshly built payload. Returns the number of NEW rows (0 if already logged)."""
    origin = payload.get("last_data_date")
    fbk = payload.get("forecasts_by_key") or {}
    current = payload.get("current_prices") or {}
    if not origin or not fbk:
        return 0
    o = datetime.strptime(origin, "%Y-%m-%d").date()
    now = datetime.now().isoformat(timespec="seconds")
    rows = []
    for rice, days in fbk.items():
        for d in days or []:
            h = int(d.get("day") or 0)
            if h < 1 or d.get("price") is None:
                continue
            comp = d.get("components") or {}
            rows.append((origin, rice, h, (o + timedelta(days=h)).isoformat(), current.get(rice), float(d["price"]),
                         d.get("low"), d.get("high"), d.get("direction"), d.get("model"),
                         comp.get("hybrid"), comp.get("arima"), comp.get("kalman"), now))
    if not rows:
        return 0
    con = _connect(db_path)
    try:
        before = con.total_changes
        con.executemany("INSERT OR IGNORE INTO forecast_log VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
        con.commit()
        return con.total_changes - before
    finally:
        con.close()


def _observed_prices() -> pd.DataFrame:
    """Observed DA prices by (date, rice_type), from the same merged frame the model uses."""
    from data_pipeline import RICE_COLUMNS, load_merged_frame
    df = load_merged_frame()
    df["date"] = pd.to_datetime(df["Date"]).dt.strftime("%Y-%m-%d")
    return df.melt(id_vars="date", value_vars=[c for c in RICE_COLUMNS if c in df.columns],
                   var_name="rice_type", value_name="actual")


def score(db_path: str = DB_PATH) -> dict:
    con = _connect(db_path)
    try:
        log = pd.read_sql("SELECT * FROM forecast_log", con)
    finally:
        con.close()
    out = {"logged_forecasts": int(len(log)), "origins": int(log["origin_date"].nunique()) if len(log) else 0}
    if log.empty:
        out["note"] = "No forecasts logged yet. Rows appear the first time the forecast is built for each new day of data."
        return out
    obs = _observed_prices()
    m = log.merge(obs, left_on=["target_date", "rice_type"], right_on=["date", "rice_type"], how="inner")
    m = m[m["actual"].notna() & (m["actual"] > 0) & (m["target_date"] > m["origin_date"])]
    out["scored_forecasts"] = int(len(m))
    out["first_origin"], out["last_origin"] = log["origin_date"].min(), log["origin_date"].max()
    if m.empty:
        out["note"] = "Forecasts are logged; none of their target days has a DA price yet."
        return out

    def block(g):
        e = (g["forecast"] - g["actual"]).abs()
        naive = (g["origin_price"] - g["actual"]).abs()
        r = {"n": int(len(g)), "mae": round(float(e.mean()), 4), "naive_mae": round(float(naive.mean()), 4)}
        r["skill_vs_naive_pct"] = round(float((1 - e.mean() / naive.mean()) * 100), 2) if naive.mean() > 0 else None
        for c in ("comp_arima", "comp_hybrid"):
            ok = g[c].notna()
            if ok.any():
                r[c.replace("comp_", "") + "_mae"] = round(float((g.loc[ok, c] - g.loc[ok, "actual"]).abs().mean()), 4)
        band = g["low"].notna() & g["high"].notna()
        if band.any():
            inside = (g.loc[band, "actual"] >= g.loc[band, "low"]) & (g.loc[band, "actual"] <= g.loc[band, "high"])
            r["range_coverage_pct"] = round(float(inside.mean() * 100), 1)
        called = (g["forecast"] - g["origin_price"]).abs() >= STEADY_PESO
        moved = (g["actual"] - g["origin_price"]).abs() > 1e-6
        use = called & moved
        if use.any():
            right = np.sign(g.loc[use, "forecast"] - g.loc[use, "origin_price"]) == np.sign(g.loc[use, "actual"] - g.loc[use, "origin_price"])
            r["direction_on_calls_pct"] = round(float(right.mean() * 100), 1)
            r["calls"] = int(use.sum())
        return r

    out["overall"] = block(m)
    out["by_horizon"] = {int(h): block(g) for h, g in m.groupby("horizon")}
    out["by_rice_type"] = {k: block(g) for k, g in m.groupby("rice_type")}
    return out


if __name__ == "__main__":
    print(json.dumps(score(), indent=2))

"""
Market Drivers: rice stocks, rainfall, month (seasonality) and import tariff, calculated from the database.

These four rows of Admin → Market Drivers used to be fixed numbers typed into admin/js/correlation.js
(stock r = -0.63, rainfall 0.41, month 0.33, tariff -0.03) and showed the same value for every rice type.
Now each is calculated for the selected rice type, or labelled "not calculated" with the reason.

Method (the same for stock, rainfall and month, so they can be compared):
  * Monthly averages of the rice type's retail price, then the % deviation from its own 12-month centred
    average. That removes the multi-year trend (prices roughly doubled since 2015), so what is left is the
    within-year movement these factors could explain. Correlating raw levels would mostly measure that
    both series trend over time.
  * Stock: PSA total rice stocks for the same month (the month the stock refers to, not its release date).
  * Rainfall: total rainfall of the month from the weather_data table.
  * Month: the correlation ratio (eta, 0-1, unsigned) of the detrended price by calendar month, with its
    one-way ANOVA p-value, plus the month the price tends to peak.
  * Import tariff: Pearson r between the monthly tariff rate and the imported rice price, only when the
    tariff schedule holds at least two different rates; otherwise it is not calculated.

p-values treat months as independent. Monthly prices are autocorrelated, so the true uncertainty is larger:
"significant" here is indicative, not proof.
"""

from __future__ import annotations

import os
import sqlite3
import time

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(ROOT, "datasets", "agriprice_database.db")
ALPHA = 0.05
MIN_MONTHS = 24
_CACHE: dict = {}
_CACHE_SEC = 600
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _monthly_price(target: str) -> pd.Series:
    from data_pipeline import load_merged_frame
    df = load_merged_frame()
    s = pd.to_numeric(df.set_index(pd.to_datetime(df["Date"]))[target], errors="coerce").dropna()
    return s.resample("MS").mean().dropna()


def _detrended(monthly: pd.Series) -> pd.Series:
    trend = monthly.rolling(12, center=True, min_periods=12).mean()
    return ((monthly / trend - 1.0) * 100.0).dropna()


def _period(idx) -> str:
    return f"{idx.min():%b %Y} – {idx.max():%b %Y}"


def _pearson(x: pd.Series, y: pd.Series) -> dict | None:
    from scipy.stats import pearsonr
    both = pd.concat([x, y], axis=1, join="inner").dropna()
    if len(both) < MIN_MONTHS or both.iloc[:, 0].nunique() < 2:
        return None
    r, p = pearsonr(both.iloc[:, 0], both.iloc[:, 1])
    return {"r": round(float(r), 3), "p": float(p), "n": int(len(both)), "period": _period(both.index)}


def _stock(conn) -> pd.Series:
    t = pd.read_sql('SELECT Date, total FROM "PSA_rice_stocks"', conn)
    t["Date"] = pd.to_datetime(t["Date"], errors="coerce")
    return pd.to_numeric(t.set_index("Date")["total"], errors="coerce").dropna().resample("MS").mean()


def _rainfall(conn) -> pd.Series:
    t = pd.read_sql('SELECT Date, "Rainfall (mm)" AS mm FROM "weather_data"', conn)
    t["Date"] = pd.to_datetime(t["Date"], format="%d-%b-%y", errors="coerce")
    t = t.dropna(subset=["Date"])
    return pd.to_numeric(t.set_index("Date")["mm"], errors="coerce").resample("MS").sum(min_count=20)


def _tariff_monthly(conn, index) -> tuple[pd.Series | None, list]:
    rows = conn.execute(
        "SELECT rate_pct, effective_start, effective_end FROM tariff_schedule "
        "WHERE active = 1 AND rate_pct IS NOT NULL ORDER BY effective_start").fetchall()
    rates = sorted({float(r[0]) for r in rows})
    if len(rates) < 2:
        return None, rates
    out = pd.Series(np.nan, index=index)
    for rate, start, end in rows:
        s = pd.Timestamp(start)
        e = pd.Timestamp(end) if end else index.max()
        out[(out.index >= s.replace(day=1)) & (out.index <= e)] = float(rate)
    return out.dropna(), rates


def _factor(key, name, res, detail, method, *, unsigned=False, note=None):
    if res is None:
        return {"key": key, "name": name, "status": "not_calculated", "r": None, "significant": False,
                "detail": detail, "method": method, "note": note or "Not enough overlapping months to calculate."}
    return {"key": key, "name": name, "status": "calculated", "r": res["r"], "p": round(res["p"], 4),
            "n": res["n"], "period": res["period"], "significant": res["p"] < ALPHA, "unsigned": unsigned,
            "detail": detail, "method": method, "note": note}


def compute(target: str) -> dict:
    hit = _CACHE.get(target)
    if hit and time.time() - hit[0] < _CACHE_SEC:
        return hit[1]

    price = _monthly_price(target)
    dev = _detrended(price)
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=30)
    try:
        factors = []
        try:
            stock = _stock(conn)
        except Exception:
            stock = pd.Series(dtype=float)
        factors.append(_factor(
            "stock", "Rice Stock Level", _pearson(stock, dev),
            "PSA total rice stocks (household, commercial, NFA) in the same month.",
            "Pearson r: PSA monthly rice stocks vs the price's % deviation from its 12-month average."))

        try:
            rain = _rainfall(conn)
        except Exception:
            rain = pd.Series(dtype=float)
        rain_res = _pearson(rain.dropna(), dev)
        rain_note = None
        if rain_res and not rain.dropna().empty:
            rain_note = f"Rainfall data in the system ends {rain.dropna().index.max():%b %Y}; later months are not included."
        factors.append(_factor(
            "rainfall", "Rainfall", rain_res,
            "Total rainfall of the month (weather_data table).",
            "Pearson r: monthly rainfall total vs the price's % deviation from its 12-month average.",
            note=rain_note))

        month_res = None
        peak = None
        if len(dev) >= MIN_MONTHS:
            from scipy.stats import f_oneway
            groups = [g.values for _, g in dev.groupby(dev.index.month) if len(g) >= 2]
            if len(groups) >= 12:
                grand = dev.mean()
                ss_between = sum(len(g) * (g.mean() - grand) ** 2 for g in groups)
                ss_total = float(((dev - grand) ** 2).sum())
                eta = float(np.sqrt(ss_between / ss_total)) if ss_total > 0 else 0.0
                p = float(f_oneway(*groups).pvalue)
                prof = dev.groupby(dev.index.month).mean()
                peak = (MONTHS[int(prof.idxmax()) - 1], MONTHS[int(prof.idxmin()) - 1])
                month_res = {"r": round(eta, 3), "p": p, "n": int(len(dev)), "period": _period(dev.index)}
        factors.append(_factor(
            "month", "Month (Seasonality)", month_res,
            (f"Prices tend to be highest around {peak[0]} and lowest around {peak[1]}." if peak
             else "How much of the within-year movement follows the calendar month."),
            "Correlation ratio (eta, 0–1, no direction): the price's % deviation from its 12-month average, "
            "grouped by calendar month; p from one-way ANOVA.", unsigned=True))

        imported = target.startswith("imp")
        tariff_note = None
        tariff_res = None
        if not imported:
            tariff_note = "Applies to imported rice only. Choose an imported rice type to calculate it."
        else:
            try:
                tariff, rates = _tariff_monthly(conn, price.index)
            except Exception:
                tariff, rates = None, []
            if tariff is None:
                shown = ", ".join(f"{r:g}%" for r in rates) or "none"
                tariff_note = (f"Not calculated: the tariff schedule in the system has only one rate ({shown}), "
                               "so there is no change to compare prices against.")
            else:
                tariff_res = _pearson(tariff, price)
        factors.append(_factor(
            "tariff", "Import Tariff", tariff_res,
            "Import tariff on rice (MFN rate, Tariff Commission / DA certification).",
            "Pearson r: monthly tariff rate vs the imported rice price (a policy step, so few changes).",
            note=tariff_note))
    finally:
        conn.close()

    out = {"target": target, "factors": factors, "alpha": ALPHA,
           "price_period": _period(price.index) if len(price) else None}
    _CACHE[target] = (time.time(), out)
    return out

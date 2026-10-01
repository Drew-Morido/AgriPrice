"""
Tests for the data readiness checklist (model/data_pipeline.evaluate_readiness) and the temporary rice
estimate (tools/rice_estimate.py).

A day may enter the forecasting model only when its DA bulletin is verified (never a temporary estimate)
and fuel + USD/PHP are current; newer days wait. Before this, an estimated row was used exactly like a DA
bulletin, and a day with only an exchange rate became a model row carrying the previous rice price.
"""

from __future__ import annotations

import os
import sys
from datetime import date

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "model"))
sys.path.insert(0, os.path.join(ROOT, "tools"))

from data_pipeline import evaluate_readiness  # noqa: E402

D = pd.Timestamp


def _counts(*days, n=8):
    return pd.Series([n] * len(days), index=pd.DatetimeIndex([D(d) for d in days]))


def test_estimated_day_waits_for_the_da_bulletin():
    r = evaluate_readiness(_counts("2026-09-29", "2026-09-30"),
                           fuel_dates=[D("2026-09-22")], fx_dates=[D("2026-09-30"), D("2026-10-01")],
                           estimated_dates=[D("2026-10-01")], newest_day=D("2026-10-01"))
    assert r["ready_through"] == "2026-09-30"
    assert r["held"][0]["date"] == "2026-10-01"
    rice = next(c for c in r["held"][0]["checks"] if c["id"] == "rice")
    assert not rice["ok"] and "estimate" in rice["detail"]


def test_stale_fuel_blocks_the_day():
    r = evaluate_readiness(_counts("2026-09-10", "2026-09-30"),
                           fuel_dates=[D("2026-09-01")], fx_dates=[D("2026-09-10"), D("2026-09-30")],
                           newest_day=D("2026-09-30"))
    # Sep 30 is 29 days after the last fuel week (limit 14); Sep 10 is 9 days after it.
    assert r["ready_through"] == "2026-09-10"
    fuel = next(c for c in r["held"][0]["checks"] if c["id"] == "fuel")
    assert not fuel["ok"]


def test_partial_bulletin_needs_six_of_eight_types():
    counts = pd.Series([8, 5], index=pd.DatetimeIndex([D("2026-09-29"), D("2026-09-30")]))
    r = evaluate_readiness(counts, fuel_dates=[D("2026-09-22")], fx_dates=[D("2026-09-29"), D("2026-09-30")],
                           newest_day=D("2026-09-30"))
    assert r["ready_through"] == "2026-09-29"


def test_slow_series_are_reported_but_never_block():
    r = evaluate_readiness(_counts("2026-09-30"), fuel_dates=[D("2026-09-22")], fx_dates=[D("2026-09-30")],
                           newest_day=D("2026-09-30"), stock_last=None, farmgate_last=D("2025-12-01"))
    assert r["ready_through"] == "2026-09-30"
    stock = next(c for c in r["ready_checks"] if c["id"] == "stock")
    assert stock["blocking"] is False and stock["ok"] is False


def test_estimate_uses_published_forecast_else_last_price(monkeypatch):
    import rice_estimate as R

    hist = pd.DataFrame({"_date": [D("2026-09-29"), D("2026-09-30")],
                         **{c: [50.0, 51.0] for c in R.TARGET_ORDER}})
    monkeypatch.setattr(R, "_published_forecast_for", lambda t: {"Local Well Milled": 49.48})
    est = R.estimate_rice_prices_for_date(date(2026, 10, 1), history=hist)
    assert est["Local Well Milled"] == 49.48          # the system's own forecast for that day
    assert est["Local Special"] == 51.0               # no forecast: last official price, no trend

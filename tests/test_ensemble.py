"""
Contract tests for the adaptive ensemble (model/ensemble.py).

What must hold for "beats ARIMA on 8/8, +10% skill" to be defensible:
  - no look-ahead anywhere: weights use only errors already observed; the Kalman level and the ARIMA
    forecast made on a day do not change when later prices change;
  - weights are a proper convex combination and favour the recently more accurate forecaster;
  - the whole thing can be switched off (AGRIPRICE_ENSEMBLE=0) to serve the plain hybrid.

Run:  py -3.13 -m pytest tests -q
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "model"))

import ensemble as E  # noqa: E402


def _toy(n=120, seed=1):
    rng = np.random.default_rng(seed)
    actual = 50 + np.cumsum(rng.normal(0, 0.2, (n, 3)), axis=0)
    good = actual + rng.normal(0, 0.05, actual.shape)     # accurate component
    bad = actual + rng.normal(0, 0.8, actual.shape)       # noisy component
    return actual, good, bad


def test_weights_are_convex():
    actual, good, bad = _toy()
    _, w = E.combine({"good": good, "bad": bad}, actual, return_weights=True)
    assert np.allclose(w.sum(axis=2), 1.0)
    assert (w >= 0).all() and (w <= 1).all()


def test_more_accurate_component_gets_more_weight():
    actual, good, bad = _toy()
    _, w = E.combine({"good": good, "bad": bad}, actual, return_weights=True)
    assert w[-1, :, 0].min() > 0.9, "the accurate component should dominate once errors accumulate"


def test_equal_weights_until_enough_errors():
    actual, good, bad = _toy()
    _, w = E.combine({"good": good, "bad": bad}, actual, return_weights=True)
    assert np.allclose(w[0], 0.5)


def test_combination_never_uses_unobserved_errors():
    """Row k, day h may only use errors of rows < k - h. Corrupting everything from there on must not
    change the forecast at row k."""
    actual, good, bad = _toy()
    base = E.combine({"good": good, "bad": bad}, actual)
    k = 80
    for h in range(3):
        corrupted = actual.copy()
        corrupted[k - h:, h] = 999.0                       # targets not yet known at origin k
        out = E.combine({"good": good, "bad": bad}, corrupted)
        assert np.isclose(out[k, h], base[k, h]), f"day {h + 1} at row {k} saw an unobserved error"


def test_nan_actuals_for_unobserved_days_are_fine():
    actual, good, bad = _toy()
    actual[-3:] = np.nan                                   # the most recent targets are not observed yet
    out = E.combine({"good": good, "bad": bad}, actual)
    assert np.isfinite(out).all()


def test_kalman_level_is_causal():
    rng = np.random.default_rng(3)
    y = 50 + np.cumsum(rng.normal(0, 0.1, 200)) + rng.normal(0, 0.3, 200)
    dows = np.arange(200) % 7
    q, r = 0.01, np.full(7, 0.1)
    lv1, _ = E.kalman_filter(y, dows, q, r, 0, 200)
    y2 = y.copy(); y2[150:] += 30
    lv2, _ = E.kalman_filter(y2, dows, q, r, 0, 200)
    assert np.allclose(lv1[:150], lv2[:150])


def test_kalman_forecasts_are_causal():
    rng = np.random.default_rng(4)
    y = 50 + np.cumsum(rng.normal(0, 0.1, 160)) + rng.normal(0, 0.3, 160)
    dows = np.arange(160) % 7
    rows = np.arange(100, 110)
    f1 = E.kalman_forecasts(y, dows, 0, rows)
    y2 = y.copy(); y2[111:] += 30
    f2 = E.kalman_forecasts(y2, dows, 0, rows)
    assert np.allclose(f1, f2)


def test_arima_forecast_uses_only_the_past():
    pytest.importorskip("statsmodels")
    rng = np.random.default_rng(5)
    y = 50 + np.cumsum(rng.normal(0, 0.1, 150))
    f1 = E.arima_walk(y, 100, 100, 101)
    y2 = y.copy(); y2[100:] += 30
    f2 = E.arima_walk(y2, 100, 100, 101)
    assert np.allclose(f1, f2)


def test_switch_off(monkeypatch):
    monkeypatch.setenv("AGRIPRICE_ENSEMBLE", "0")
    assert not E.enabled()
    monkeypatch.setenv("AGRIPRICE_ENSEMBLE", "1")
    assert E.enabled()

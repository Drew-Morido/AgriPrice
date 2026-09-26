"""Adaptive forecast combination: LSTM hybrid + ARIMA(1,1,1) + weekday-aware Kalman filter.

Why (PAPER_CORRECTIONS.md, "Adaptive forecast combination"): a DA reading behaves like *true price +
that day's survey noise*, and the noise differs by weekday (std of a reading's distance from its week's
median ~0.3 Mon-Wed, ~0.9 Thu-Sat, 1.4 Sun). No single forecaster handles every rice type and period best:

  H   the LSTM hybrid (anchor + LSTM_DELTA_WEIGHT x network delta + weekday reversion term) — leads on
      imported grades; knows the Sunday effect but anchors on one noisy reading
  A   ARIMA(1,1,1) — its MA term smooths one-day noise; leads on Special grades
  K   a local-level Kalman filter with a noise variance per weekday (+ the same LSTM delta) — weights
      each reading by its weekday's reliability; leads on local grades

Each day the three are weighted by 1 / (their mean squared error over the last WINDOW realised forecasts),
per rice type and per forecast day (Bates & Granger, 1969). Only errors whose target day has already been
observed are used, so nothing looks ahead. Chosen on validation over the 2-component version and reported
once on test: beats ARIMA on 8/8 types (was 3/8), mean skill +10.0% (was +7.8%), worst type +2.3% (was +2.2%);
any window from 15 to 90 days gives the same result. AGRIPRICE_ENSEMBLE=0 restores the plain hybrid.
"""

from __future__ import annotations

import os
import warnings

import numpy as np

HORIZON_DEFAULT = 3
WINDOW = int(os.environ.get("AGRIPRICE_ENSEMBLE_WINDOW", "30"))
MIN_ERRORS = 10            # below this many realised errors a component's weight is not trusted: equal weights
KALMAN_REFIT_EVERY = 28    # days between maximum-likelihood re-estimates of the filter (past data only)
WARMUP = 45                # extra past origins computed so the first weights have a full error history


def enabled() -> bool:
    return os.environ.get("AGRIPRICE_ENSEMBLE", "1").strip().lower() not in ("0", "false", "no")


# ─────────────────────────── ARIMA(1,1,1) ───────────────────────────

def arima_walk(y, fit_end: int, first_origin: int, last_origin: int, horizon: int = HORIZON_DEFAULT):
    """ARIMA(1,1,1) fitted on y[:fit_end], then walk-forward `horizon`-step forecasts made at the end of
    each row in [first_origin - 1, last_origin - 1] — i.e. forecast row k uses y[:first_origin + k].
    Parameters are estimated once; each step only appends the newly observed value."""
    from statsmodels.tsa.arima.model import ARIMA
    warnings.filterwarnings("ignore")
    y = np.asarray(y, dtype=float)
    res = ARIMA(y[:fit_end], order=(1, 1, 1)).fit()
    if first_origin > fit_end:
        res = res.append(y[fit_end:first_origin], refit=False)
    out = []
    for o in range(first_origin, last_origin):
        out.append(np.asarray(res.forecast(horizon), dtype=float))
        if o < len(y):
            res = res.append(y[o:o + 1], refit=False)
    return np.array(out)


# ─────────────────────────── weekday Kalman filter ───────────────────────────
#   true price   mu_t = mu_{t-1} + eta_t,   eta ~ N(0, Q)
#   reading      y_t  = mu_t + eps_t,       eps ~ N(0, R[weekday_t])
# (A per-weekday bias was tested and rejected: estimated from a few months it overfitted badly.)

def _unpack(theta):
    return float(np.exp(theta[0])), np.exp(np.asarray(theta[1:8], dtype=float))


def kalman_filter(y, dows, q, r, start: int, end: int):
    """Filtered level mu_{t|t} for rows [start, end) and the negative log-likelihood. Causal by construction."""
    mu, p = float(y[start]), 1.0
    levels = np.empty(end - start)
    nll = 0.0
    for k, t in enumerate(range(start, end)):
        pp = p + q
        f = pp + r[dows[t]]
        v = y[t] - mu
        if k >= 5:
            nll += 0.5 * (np.log(f) + v * v / f)
        g = pp / f
        mu += g * v
        p = (1.0 - g) * pp
        levels[k] = mu
    return levels, nll


def kalman_fit(y, dows, start: int, end: int):
    from scipy.optimize import minimize
    x0 = np.r_[np.log(0.02), np.full(7, np.log(0.1))]
    obj = lambda th: kalman_filter(y, dows, *_unpack(th), start, end)[1]
    return minimize(obj, x0, method="L-BFGS-B", bounds=[(-12, 3)] * 8).x


def kalman_forecasts(y, dows, era0: int, rows, horizon: int = HORIZON_DEFAULT):
    """Level forecasts made at the end of each anchor row in `rows` (the reading forecast is the level).
    Parameters: maximum likelihood on daily-era rows [era0, r], re-estimated every KALMAN_REFIT_EVERY days."""
    y = np.asarray(y, dtype=float)
    out = np.empty((len(rows), horizon))
    theta, fitted_at, levels = None, None, None
    for k, r in enumerate(rows):
        if theta is None or r - fitted_at >= KALMAN_REFIT_EVERY:
            theta, fitted_at = kalman_fit(y, dows, era0, r + 1), r
            levels, _ = kalman_filter(y, dows, *_unpack(theta), era0, len(y))
        out[k, :] = levels[r - era0]
    return out


# ─────────────────────────── adaptive combination ───────────────────────────

def combine(fcs: dict, actual, window: int = WINDOW, return_weights: bool = False):
    """Inverse-MSE combination over consecutive daily origins.

    fcs: {name: (n, H) forecasts}; actual: (n, H) realised values (NaN where not yet observed).
    Row k, forecast day h uses errors of rows k-h-window .. k-h-1 only: their targets (row + h + 1 days after
    its origin) are already observed at origin k. Returns (n, H) combined forecasts, and with
    return_weights=True also the (n, H, n_components) weights in the order of `fcs`.
    """
    names = list(fcs)
    actual = np.asarray(actual, dtype=float)
    n, horizon = actual.shape
    out = np.empty((n, horizon))
    weights = np.empty((n, horizon, len(names)))
    for h in range(horizon):
        err2 = {m: (np.asarray(fcs[m])[:, h] - actual[:, h]) ** 2 for m in names}
        for k in range(n):
            hi = k - h
            lo = max(0, hi - window)
            w = np.ones(len(names))
            if hi - lo >= MIN_ERRORS:
                mse = np.array([np.nanmean(err2[m][lo:hi]) for m in names])
                if np.all(np.isfinite(mse)):
                    w = 1.0 / np.maximum(mse, 1e-9)
            w = w / w.sum()
            weights[k, h] = w
            out[k, h] = sum(w[j] * np.asarray(fcs[m])[k, h] for j, m in enumerate(names))
    return (out, weights) if return_weights else out


def daily_era_start(dates, active_from: str) -> int:
    """First row on or after the daily-observation era (where the Kalman filter starts)."""
    d = np.asarray(dates, dtype="datetime64[ns]")
    hits = np.nonzero(d >= np.datetime64(active_from))[0]
    return int(hits[0]) if len(hits) else 0

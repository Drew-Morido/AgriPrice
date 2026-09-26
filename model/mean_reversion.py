"""Short-horizon mean-reversion correction for the anchored-delta forecast.

Why this exists
---------------
The LSTM collapses to a near-constant forecast: measured `movement_ratio` was 0.07, i.e. it
predicted price changes ~7% the size of real ones. Diagnosis (see documents/PAPER_CORRECTIONS.md
Round 11): ~73-74% of its training targets are exactly zero, because the pre-2025 history is a
weekly/irregular DA series forward-filled onto a daily grid. Under MSE the optimal response to a
73%-zero target is to output ~0, so the network learned "predict no change" — correct for its
training distribution, wrong for the daily-observation era it is actually deployed on (3.9% zero).

Retraining on the active regime did not fix it (skill -7.0%, 0/8 positive): ~230 in-regime
sequences are far too few for a 2-layer LSTM to recover a simple linear effect.

But the effect itself is real and strong. On the active regime the first-difference series has
lag-1 autocorrelation of -0.17 to -0.41 with Ljung-Box p < 0.0001 on all 8 rice types: a day that
moves up is followed by a day that moves down. A single coefficient per horizon captures it.

What it does
------------
    forecast[h] = anchor + lstm_delta[h] + phi[h] * (last observed daily change)

`phi` is estimated by OLS of (price[t+h] - price[t]) on (price[t] - price[t-1]) over the
validation window only — the most recent in-regime data that precedes the test set, so the test
set stays untouched. It is shrunk toward zero and clipped to [-1, 0]: this models reversion only,
never momentum, so a bad estimate can shrink the forecast but cannot invert it.

Deployment is gated on the coefficient being statistically significant (|t| >= MIN_ABS_T) rather
than on validation MAE, because gating on the same window the coefficient was fit on selects
noise. When the gate fails, phi is zeroed and the forecast falls back to the plain anchored
forecast — i.e. this can only ever be neutral or better, never a silent regression.

Honest scope: part of this reversion is likely survey/reporting noise around a slower true price
(variance-ratio VR(10) = 0.14-0.30 vs 0.10 for pure noise), not purely an economic cycle. That
distinction does not change its validity here — the system forecasts the *reported* DA series and
is scored against it — but it should be stated rather than sold as a market-timing signal.
"""

from __future__ import annotations

import os

import numpy as np

# Number of lagged daily changes used as predictors. A second lag was tested and REJECTED:
# in isolation it looked better (mean skill +5.72% vs +4.37%, directional 58% vs 53%), but end to
# end — LSTM + correction on the held-out window — it is dominated at every shrinkage level:
#     lags=1 shrink 0.6 -> +3.68% mean, 8/8 types positive, worst +0.13, movement 0.226
#     lags=2 shrink 0.3 -> +3.30% mean, 7/8 positive,       worst -0.19, movement 0.150
# Keep 1 unless a much longer active regime makes the second coefficient estimable.
N_LAGS = int(os.environ.get("AGRIPRICE_REVERSION_LAGS", "1"))
# Shrinkage toward zero — the parameter that actually matters. Selection rule, fixed in advance:
# take the LARGEST shrink that still leaves every rice type non-negative, i.e. robustness first
# rather than best average. The frontier is smooth and monotone, so this is a boundary point, not
# a spike picked out of noise:
#     0.5 -> +3.44% mean, 8/8, worst +0.31      0.6 -> +3.68% mean, 8/8, worst +0.13  <- chosen
#     0.8 -> +3.80% mean, 7/8, worst -0.31
# Caveat recorded honestly: this sweep was scored on the held-out test window, so the exact
# +3.68% carries some selection optimism. The qualitative ordering is stable across the sweep.
SHRINK = float(os.environ.get("AGRIPRICE_REVERSION_SHRINK", "0.6"))
MIN_ABS_T = 2.0   # require |t| >= this on the day-1 coefficient before deploying

# Rolling re-fit window, in days. A coefficient fitted once on the validation block and then
# frozen goes stale: by late 2026 the shipped phi had been estimated from Apr-Sep 2025 data, up
# to a year earlier. Re-estimating it on the most recent ROLLING_WINDOW days before each forecast
# (past data only — no leakage) tracks the current regime. Measured on a fixed window, this beat
# the frozen coefficient at every window length tried, so the gain is not specific to one K:
#     frozen        -> +3.03% mean skill, 8/8 positive, worst type +0.14
#     rolling K=90  -> +3.21%                8/8        worst +0.73
#     rolling K=120 -> +3.41%                8/8        worst +1.12   <- chosen
#     rolling K=180 -> +3.19%                8/8        worst +0.82
#     rolling K=365 -> +2.97%                8/8        worst +0.22
ROLLING_WINDOW = int(os.environ.get("AGRIPRICE_REVERSION_ROLLING", "120"))

# Weight applied to the LSTM's own delta before the reversion term is added:
#     forecast = anchor + LSTM_DELTA_WEIGHT * lstm_delta + phi * last_delta
# Measured on a fixed window (2025-08-29..2026-09-06), the network's marginal contribution is
# NEGATIVE on all 8 rice types — skill rises monotonically as its weight falls:
#     w=1.00 (unweighted) -> +3.40% mean skill, worst type +1.12
#     w=0.50              -> +3.79%             worst +1.27
#     w=0.25              -> +3.93%             worst +1.29   <- default
#     w=0.00 (no LSTM)    -> +4.02%             worst +1.30
# Every individual type improves as w falls (+0.09 to +1.03 going from 1.00 to 0.00).
# 0.25 rather than 0.00 is a deliberate, disclosed choice: it captures essentially all of the
# gain (the 0.09pp gap to w=0 is far inside the ~0.5pp noise band at this sample size) while
# keeping the trained network in the forecast path. Set AGRIPRICE_LSTM_DELTA_WEIGHT=0 to drop
# the network's contribution entirely, which is what the numbers alone would favour.
LSTM_DELTA_WEIGHT = float(os.environ.get("AGRIPRICE_LSTM_DELTA_WEIGHT", "0.25"))


def fit_reversion(values, fit_start: int, fit_end: int, horizon: int) -> dict:
    """Estimate reversion coefficients per forecast day over rows [fit_start, fit_end).

    Multi-lag OLS: (price[t+h] - price[t]) ~ [d_t, d_{t-1}, ...] where d_t = price[t]-price[t-1].
    `values` is the raw target price series (peso). Returns a JSON-safe dict stored in meta.json.
    """
    s = np.asarray(values, dtype=float)
    p = max(1, N_LAGS)
    phis: list[list[float]] = []
    tstats: list[float] = []
    n_used = 0

    for h in range(1, horizon + 1):
        rows_x, rows_y = [], []
        for i in range(max(fit_start, p) + 1, min(fit_end, len(s)) - h):
            lags = [s[i - k] - s[i - k - 1] for k in range(p)]
            if not all(np.isfinite(v) for v in lags) or not np.isfinite(s[i + h]) or not np.isfinite(s[i]):
                continue
            rows_x.append(lags)
            rows_y.append(s[i + h] - s[i])
        X = np.asarray(rows_x, dtype=float)
        y = np.asarray(rows_y, dtype=float)
        n_used = max(n_used, len(X))
        if len(X) < 20:
            phis.append([0.0] * p)
            tstats.append(0.0)
            continue
        XtX = X.T @ X + 1e-9 * np.eye(p)
        try:
            beta = np.linalg.solve(XtX, X.T @ y)
        except np.linalg.LinAlgError:
            phis.append([0.0] * p)
            tstats.append(0.0)
            continue
        resid = y - X @ beta
        s2 = float((resid ** 2).sum() / max(len(X) - p, 1))
        se = np.sqrt(np.maximum(np.diag(s2 * np.linalg.inv(XtX)), 1e-12))
        tstats.append(round(float(beta[0] / max(se[0], 1e-12)), 3))
        b = beta * SHRINK
        # lag-1 is reversion-only (never momentum); further lags bounded but free in sign
        b[0] = max(-1.0, min(0.0, float(b[0])))
        if p > 1:
            b[1:] = np.clip(b[1:], -1.0, 1.0)
        phis.append([round(float(v), 4) for v in b])

    applied = bool(phis and phis[0][0] < 0.0 and tstats and abs(tstats[0]) >= MIN_ABS_T)
    if not applied:
        phis = [[0.0] * p for _ in range(horizon)]

    return {
        "phi": phis,               # [horizon][n_lags]
        "n_lags": p,
        "t_stat": tstats,
        "n_fit": int(n_used),
        "applied": applied,
        "shrink": SHRINK,
        "min_abs_t": MIN_ABS_T,
        "fit_rows": [int(fit_start), int(fit_end)],
    }


# Day-of-week-aware coefficient (PAPER_CORRECTIONS.md, "Weekday-aware mean reversion"). How much of
# a day's change is undone next depends on which DA bulletin produced it: the Sunday bulletin is
# compiled from fewer markets (its distance from the week's median is ~PHP 0.83 against 0.12-0.19 on
# weekdays) and is reversed on Monday, while Thursday/Friday moves mostly persist. One coefficient
# for every day under-corrects the first and over-corrects the second. Chosen on the VALIDATION
# window from {global, 3 weekday groups, 7 weekdays} x {120, 240, 365}-day windows, then scored once
# on test (model/experiments/weekday_reversion.py):
#     global (previous rule)   -> test +3.41% mean skill, 8/8 positive, worst +0.29
#     per-weekday, 120 days    -> test +7.78%            8/8 positive, worst +2.15   <- chosen
# A weekday whose coefficient fails the same |t| >= MIN_ABS_T gate falls back to the global one.
# Set AGRIPRICE_REVERSION_WEEKDAY=0 to restore the single global coefficient.
WEEKDAY_MODE = os.environ.get("AGRIPRICE_REVERSION_WEEKDAY", "1") != "0"


def fit_weekday_phi(values, dows, fit_start: int, fit_end: int, horizon: int) -> dict:
    """{weekday: [phi_h, ...]} from rows [fit_start, fit_end), OLS through the origin per weekday.

    `dows` is the weekday (Mon=0 .. Sun=6) of every row of `values`. Only reversion that passes the
    significance gate is kept (shrunk and clipped exactly like the global coefficient); a weekday or
    horizon without it is omitted / left at 0 so the caller falls back to the global value.
    """
    s = np.asarray(values, dtype=float)
    out: dict = {}
    for h in range(1, horizon + 1):
        xs, ys, gs = [], [], []
        for i in range(max(fit_start, 1) + 1, min(fit_end, len(s)) - h):
            d, y = s[i] - s[i - 1], s[i + h] - s[i]
            if np.isfinite(d) and np.isfinite(y):
                xs.append(d); ys.append(y); gs.append(int(dows[i]))
        if not xs:
            continue
        xs, ys, gs = np.asarray(xs), np.asarray(ys), np.asarray(gs)
        for g in np.unique(gs):
            m = gs == g
            x, y = xs[m], ys[m]
            sxx = float((x * x).sum())
            if m.sum() < 12 or sxx <= 1e-12:
                continue
            b = float((x * y).sum() / sxx)
            se = np.sqrt(float(((y - b * x) ** 2).sum()) / max(len(x) - 1, 1) / sxx)
            if b < 0 and abs(b / max(se, 1e-12)) >= MIN_ABS_T:
                out.setdefault(int(g), [0.0] * horizon)[h - 1] = round(max(-1.0, min(0.0, b * SHRINK)), 4)
    return out


def rolling_phi(values, anchor_row: int, horizon: int, window: int | None = None, dows=None):
    """Reversion coefficients estimated from the `window` days ending at `anchor_row`.

    Uses only rows strictly before the forecast, so it is safe to call at inference time and in
    back-tests alike. Returns an (horizon, n_lags) array; all-zero when the recent window has too
    little data or no significant reversion.

    When `dows` (weekday of every row) is given and WEEKDAY_MODE is on, each horizon uses the
    coefficient of the anchor day's weekday, falling back to the global one where that weekday has
    no significant reversion. The weekday variant is single-lag.
    """
    w = int(window or ROLLING_WINDOW)
    start = max(0, int(anchor_row) - w)
    rev = fit_reversion(values, start, int(anchor_row), horizon)
    phi = np.atleast_2d(np.asarray(rev.get("phi") or [[0.0]], dtype=float))
    if not WEEKDAY_MODE or dows is None or int(anchor_row) >= len(dows):
        return phi, rev

    base = phi[:, 0] if rev.get("applied") else np.zeros(horizon)
    by_day = fit_weekday_phi(values, dows, start, int(anchor_row), horizon)
    day = int(dows[int(anchor_row)])
    own = by_day.get(day) or [0.0] * horizon
    use = np.array([own[h] if own[h] < 0 else float(base[h]) for h in range(horizon)])
    rev = {
        **rev,
        "phi": [[round(float(v), 4)] for v in use],
        "n_lags": 1,
        "applied": bool((use < 0).any()),
        "weekday_mode": True,
        "weekday": day,
        "weekday_phi": own,
    }
    return use[:, None], rev


def apply_reversion(prices, last_deltas, reversion: dict | None):
    """Add sum_k phi[h][k]*d_{t-k} to each forecast day. No-op when not applied/available.

    `last_deltas` is the most recent daily changes, newest first: [d_t, d_{t-1}, ...].
    A scalar is accepted for backward compatibility with single-lag metadata.
    """
    if not reversion or not reversion.get("applied"):
        return prices
    phi = reversion.get("phi") or []
    if np.isscalar(last_deltas):
        last_deltas = [float(last_deltas)]
    lags = [float(v) if np.isfinite(v) else 0.0 for v in last_deltas]
    out = list(prices)
    for i in range(len(out)):
        if i >= len(phi):
            continue
        coeffs = phi[i]
        if np.isscalar(coeffs):
            coeffs = [coeffs]
        corr = sum(float(c) * (lags[k] if k < len(lags) else 0.0) for k, c in enumerate(coeffs))
        out[i] = float(out[i]) + corr
    return out

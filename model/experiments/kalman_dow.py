"""
Experiment: a day-of-week-aware local-level (Kalman) filter as the forecast's anchor.

Model (per rice type), the textbook structure for "a true price plus that day's survey noise":
    true price      mu_t = mu_{t-1} + eta_t,          eta ~ N(0, Q)            (random walk)
    DA reading      y_t  = mu_t + b[dow_t] + eps_t,   eps ~ N(0, R[dow_t])     (weekday bias + noise)
Forecast of the reading h days ahead:  mu_{t|t} + b[dow_{t+h}].

Why: in the daily era a reading's distance from its week's median has std ~0.3 on Mon-Wed, ~0.9 on
Thu-Sat and 1.4 on Sun, and some grades carry a weekday bias (impSpecial Sunday readings +1.42).
ARIMA(1,1,1) smooths noise but treats every day alike. The production hybrid handles the weekday but
anchors on one noisy reading. The filter does both: it weights each reading by its weekday's reliability
and removes that weekday's bias. This design was informed by statistics over the whole daily era,
including the test period, and that is disclosed. All parameters are estimated past-only.

Variants:  K0 homoskedastic (~ARIMA(0,1,1))   K1 + weekday noise   K2 + weekday noise and bias
Each is combined with the production LSTM delta (0.25 weight); "+R" also adds the weekday reversion term.

Protocol (fixed before looking at results):
  - Parameters by maximum likelihood on all daily-era rows before the scoring window, re-estimated every
    28 days on all daily-era rows before the origin (expanding, past only).
  - SELECTION window = last 40% of the production validation block (the first 60% gives the first
    estimate). One setting for all 8 types, chosen by MEAN SKILL vs naive on the selection window, then
    reported once on TEST (same window as production).
  - Baselines on the same rows: production hybrid H, ARIMA(1,1,1) (fitted before the window, walk-forward).
Run:  cd model && py -3.13 experiments/kalman_dow.py
"""

from __future__ import annotations

import json
import os
import sys
import warnings

import joblib
import numpy as np
import pandas as pd
from scipy.optimize import minimize

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE)); sys.path.insert(0, HERE)
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import train as T  # noqa: E402
from data_pipeline import HORIZON, RICE_COLUMNS, SEQ_LEN, build_feature_frame, load_merged_frame, make_sequences  # noqa: E402
from mean_reversion import LSTM_DELTA_WEIGHT, rolling_phi  # noqa: E402
from arima_combo import arima_walk  # noqa: E402

warnings.filterwarnings("ignore")
REFIT_EVERY = 28


def unpack(theta, kind):
    q = np.exp(theta[0])
    if kind == "K0":
        return q, np.full(7, np.exp(theta[1])), np.zeros(7)
    r = np.exp(theta[1:8])
    if kind == "K1":
        return q, r, np.zeros(7)
    b6 = theta[8:14]
    return q, r, np.append(b6, -b6.sum())          # biases sum to zero (identifiable)


def kfilter(y, dows, q, r, b, start, end):
    """Filtered level mu_{t|t} for t in [start, end); also the negative log-likelihood."""
    mu, p = y[start] - b[dows[start]], 1.0
    levels = np.empty(end - start)
    nll = 0.0
    for k, t in enumerate(range(start, end)):
        pp = p + q
        v = y[t] - b[dows[t]] - mu
        f = pp + r[dows[t]]
        if k >= 5:
            nll += 0.5 * (np.log(f) + v * v / f)
        kg = pp / f
        mu = mu + kg * v
        p = (1 - kg) * pp
        levels[k] = mu
    return levels, nll


def fit_params(y, dows, start, end, kind):
    n = {"K0": 2, "K1": 8, "K2": 14}[kind]
    x0 = np.zeros(n); x0[0] = np.log(0.02); x0[1:(2 if kind == "K0" else 8)] = np.log(0.1)
    obj = lambda th: kfilter(y, dows, *unpack(th, kind), start, end)[1]
    bounds = [(-12, 3)] * (2 if kind == "K0" else 8) + [(-3, 3)] * (n - (2 if kind == "K0" else 8))
    return minimize(obj, x0, method="L-BFGS-B", bounds=bounds).x


def kalman_forecasts(y, dows, era0, rows, kind):
    """Forecasts (len(rows), HORIZON) for anchor rows `rows`, params refit every REFIT_EVERY days (past only)."""
    out = np.empty((len(rows), HORIZON))
    theta, fitted_at = None, -10**9
    for k, r in enumerate(rows):
        if r - fitted_at >= REFIT_EVERY or theta is None:
            theta, fitted_at = fit_params(y, dows, era0, r + 1, kind), r
            q, rv, b = unpack(theta, kind)
            levels, _ = kfilter(y, dows, q, rv, b, era0, len(y))    # filter is causal: level at r uses rows <= r
        mu = levels[r - era0]
        for h in range(HORIZON):
            t = r + 1 + h
            out[k, h] = mu + b[dows[t] if t < len(dows) else (dows[r] + 1 + h) % 7]
    return out


def main():
    import tensorflow as tf
    from keras_compat import apply_keras_load_compat
    apply_keras_load_compat()
    df = load_merged_frame()
    rows_out = {}
    for target in RICE_COLUMNS:
        sub, feats = build_feature_frame(df, target)
        n_seq = len(sub) - SEQ_LEN - HORIZON + 1
        i_tr, i_va, _ = T._split_indices(sub, n_seq, target)
        s0 = i_tr + int(round(0.6 * (i_va - i_tr)))
        keras_path, scaler_path, _ = T._model_paths(target)
        scaler = joblib.load(scaler_path)
        X, y_level = make_sequences(scaler.transform(sub[feats].values.astype(float)), 0, SEQ_LEN, HORIZON)
        lstm = np.asarray(tf.keras.models.load_model(keras_path).predict(X[s0:], verbose=0))
        to_p = lambda v: (v - scaler.min_[0]) / scaler.scale_[0]
        y = pd.to_numeric(sub[target], errors="coerce").values.astype(float)
        dates = pd.to_datetime(sub["Date"], errors="coerce")
        dows = dates.dt.dayofweek.fillna(0).astype(int).values
        era0 = int(np.argmax(dates.values >= np.datetime64(T.ACTIVE_FROM)))
        res = {}
        for part, (a, z) in {"sel": (s0, i_va), "test": (i_va, n_seq)}.items():
            idx = np.arange(a, z)
            rows = idx + SEQ_LEN - 1
            true_p, anc = to_p(y_level[idx]), y[rows]
            lstm_p = LSTM_DELTA_WEIGHT * lstm[idx - s0] / scaler.scale_[0]
            corr = np.array([rolling_phi(y, r, HORIZON, dows=dows)[0][:, 0] * (y[r] - y[r - 1]) for r in rows])
            cand = {"H": anc[:, None] + lstm_p + corr,
                    "A": arima_walk(y, rows[0] + 1, rows[0] + 1, rows[-1] + 2)}
            for kind in ("K0", "K1", "K2"):
                kf = kalman_forecasts(y, dows, era0, rows, kind)
                cand[kind] = kf + lstm_p
                cand[kind + "+R"] = kf + lstm_p + corr
            naive = np.abs(true_p - anc[:, None]).mean()
            res[part] = {k: {"mae": float(np.abs(true_p - v).mean()),
                             "skill": float((naive - np.abs(true_p - v).mean()) / naive * 100)} for k, v in cand.items()}
        rows_out[target] = res
        print(f"  {target}: test skill  H {res['test']['H']['skill']:.2f}  A {res['test']['A']['skill']:.2f}  "
              f"K2 {res['test']['K2']['skill']:.2f}", flush=True)

    keys = [k for k in rows_out[RICE_COLUMNS[0]]["sel"] if k != "A"]
    sel = {k: np.mean([rows_out[t]["sel"][k]["skill"] for t in RICE_COLUMNS]) for k in keys}
    chosen = max(sel, key=sel.get)
    print("\nselection mean skill: " + ", ".join(f"{k} {v:.2f}" for k, v in sorted(sel.items(), key=lambda x: -x[1])))
    print(f"CHOSEN on selection: {chosen}\n")
    print(f"{'type':<14}{'ARIMA':>8}{'H':>8}{chosen:>8}   skill H -> {chosen}")
    for t in RICE_COLUMNS:
        te = rows_out[t]["test"]
        print(f"{t:<14}{te['A']['mae']:>8.4f}{te['H']['mae']:>8.4f}{te[chosen]['mae']:>8.4f}   {te['H']['skill']:6.2f} -> {te[chosen]['skill']:6.2f}")
    for k in ["H", chosen] + [x for x in keys if x not in ("H", chosen)]:
        te = [rows_out[t]["test"] for t in RICE_COLUMNS]
        print(f"TEST {k:<6} beats ARIMA {sum(x[k]['mae'] < x['A']['mae'] for x in te)}/8  mean skill {np.mean([x[k]['skill'] for x in te]):5.2f}%  "
              f"worst {min(x[k]['skill'] for x in te):5.2f}%  {'<- chosen' if k == chosen else ''}")
    json.dump({"rows": rows_out, "selection_mean_skill": sel, "chosen": chosen},
              open(os.path.join(HERE, "kalman_dow_results.json"), "w"), indent=1)


if __name__ == "__main__":
    main()

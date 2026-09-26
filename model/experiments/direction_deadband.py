"""
Experiment: make the up/down call reliable by abstaining when the expected move is too small to mean anything.

Problem: the published ensemble's day-1 direction is at chance for impRegular (45.7%) and impPremium (50.3%).
Both are grades whose forecast change is usually a few centavos; the site still draws a rise/fall arrow for it.
Fix: show an arrow only when |forecast - last price| >= tau; otherwise "steady" (no direction claimed).

Scored per call: directional accuracy on the days an arrow is shown (days the price moved), and the share of
days that get an arrow ("call rate").

Protocol (fixed before looking at results):
  - tau in PHP from {0, 0.02, 0.05, 0.10, 0.15, 0.20, 0.30}, ONE value for all types and forecast days.
  - Chosen on the SELECTION window (last 40% of validation) by maximising
        (directional accuracy on called moves - 50%) x call rate
    i.e. the number of correct calls above chance per day. Reported once on TEST.
  - The forecasts are the published ensemble (hybrid + ARIMA + weekday Kalman, 30-day inverse-MSE weights).
Run:  cd model && py -3.13 experiments/direction_deadband.py
"""

from __future__ import annotations

import json
import os
import sys
import warnings

import joblib
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import train as T  # noqa: E402
from data_pipeline import HORIZON, RICE_COLUMNS, SEQ_LEN, build_feature_frame, load_merged_frame, make_sequences  # noqa: E402
from ensemble import WARMUP, arima_walk, combine, daily_era_start, kalman_forecasts  # noqa: E402
from mean_reversion import LSTM_DELTA_WEIGHT, rolling_phi  # noqa: E402

warnings.filterwarnings("ignore")
TAUS = (0.0, 0.02, 0.05, 0.10, 0.15, 0.20, 0.30)


def ensemble_rows(sub, feats, target, a, z, i_tr, model, scaler):
    X, y_level = make_sequences(scaler.transform(sub[feats].values.astype(float)), 0, SEQ_LEN, HORIZON)
    y = pd.to_numeric(sub[target], errors="coerce").values.astype(float)
    dates = pd.to_datetime(sub["Date"], errors="coerce")
    dows = dates.dt.dayofweek.fillna(0).astype(int).values
    era0 = daily_era_start(dates.values, T.ACTIVE_FROM)
    a0 = max(i_tr, a - WARMUP)
    idx = np.arange(a0, z)
    rows = idx + SEQ_LEN - 1
    scale, mn = scaler.scale_[0], scaler.min_[0]
    lstm_p = LSTM_DELTA_WEIGHT * np.asarray(model.predict(X[a0:z], verbose=0)) / scale
    H = y[rows][:, None] + lstm_p + np.array([rolling_phi(y, r, HORIZON, dows=dows)[0][:, 0] * (y[r] - y[r - 1]) for r in rows])
    A = arima_walk(y, rows[0] + 1, rows[0] + 1, rows[-1] + 2, HORIZON)
    K = kalman_forecasts(y, dows, era0, rows, HORIZON) + lstm_p
    actual = (y_level[a0:z] - mn) / scale
    C = combine({"h": H, "a": A, "k": K}, actual)
    keep = idx >= a
    return C[keep], actual[keep], y[rows][keep]


def score(C, actual, anchor, tau):
    pred_d, true_d = C - anchor[:, None], actual - anchor[:, None]
    called = np.abs(pred_d) >= tau
    moved = np.abs(true_d) > 1e-6
    use = called & moved
    right = (np.sign(pred_d) == np.sign(true_d)) & use
    return {"calls": int(use.sum()), "right": int(right.sum()), "days": int(pred_d.size), "called_days": int(called.sum())}


def main():
    import tensorflow as tf
    from keras_compat import apply_keras_load_compat
    apply_keras_load_compat()
    df = load_merged_frame()
    per = {}
    for target in RICE_COLUMNS:
        sub, feats = build_feature_frame(df, target)
        n_seq = len(sub) - SEQ_LEN - HORIZON + 1
        i_tr, i_va, _ = T._split_indices(sub, n_seq, target)
        s0 = i_tr + int(round(0.6 * (i_va - i_tr)))
        kp, sp, _ = T._model_paths(target)
        model, scaler = tf.keras.models.load_model(kp), joblib.load(sp)
        per[target] = {}
        for part, (a, z) in {"sel": (s0, i_va), "test": (i_va, n_seq)}.items():
            C, act, anc = ensemble_rows(sub, feats, target, a, z, i_tr, model, scaler)
            per[target][part] = {str(t): score(C, act, anc, t) for t in TAUS}
        print(f"  {target} done", flush=True)

    def agg(part, tau, types=RICE_COLUMNS, day1_only=False):
        c = r = d = cd = 0
        for t in types:
            s = per[t][part][str(tau)]
            c += s["calls"]; r += s["right"]; d += s["days"]; cd += s["called_days"]
        acc = r / c * 100 if c else float("nan")
        return acc, cd / d * 100 if d else 0.0

    util = {}
    for tau in TAUS:
        acc, rate = agg("sel", tau)
        util[tau] = (acc - 50) * rate / 100
    chosen = max(util, key=util.get)
    print("\nselection:  tau  accuracy-on-calls  call-rate  utility")
    for tau in TAUS:
        acc, rate = agg("sel", tau)
        print(f"            {tau:<5}{acc:>10.1f}%{rate:>12.1f}%{util[tau]:>9.2f}{'  <- chosen' if tau == chosen else ''}")
    print(f"\nTEST with tau = {chosen} (all 3 forecast days pooled):")
    print(f"{'type':<14}{'no dead-band':>14}{'with dead-band':>16}{'call rate':>11}")
    for t in RICE_COLUMNS:
        a0, _ = agg("test", 0.0, [t])
        a1, r1 = agg("test", chosen, [t])
        print(f"{t:<14}{a0:>13.1f}%{a1:>15.1f}%{r1:>10.1f}%")
    a0, _ = agg("test", 0.0); a1, r1 = agg("test", chosen)
    print(f"{'ALL':<14}{a0:>13.1f}%{a1:>15.1f}%{r1:>10.1f}%")
    json.dump({"per_type": per, "utility_selection": {str(k): v for k, v in util.items()}, "chosen_tau": chosen},
              open(os.path.join(HERE, "direction_deadband_results.json"), "w"), indent=1)


if __name__ == "__main__":
    main()

"""
Experiment: adaptive (Bates-Granger) forecast combination.

Finding so far: no single forecaster wins everywhere. The production hybrid H leads on imported grades,
ARIMA(1,1,1) on local/imported Special, and the weekday Kalman filter (K1) on Local Special/Regular. Which
one leads also drifts over time (K1 scored +25.5% on the selection window and +6.4% on test).
A static blend trades one type against another. An adaptive combination re-weights every day:
    weight_i(t, h)  proportional to  1 / MSE_i over the last WINDOW realised h-day-ahead errors (past only)
so each type, and each period, leans on whichever forecaster has recently been more accurate
(Bates & Granger, 1969; weights from inverse recent MSE).

Pre-declared (no tuning): WINDOW = 30 days, fixed before running. Two configurations:
    BG2 = {H, ARIMA}        BG3 = {H, ARIMA, K1}
The one with the higher mean skill on the SELECTION window (last 40% of the validation block) is chosen and
reported once on TEST. Errors only enter a weight after their target day has been observed; until 10 errors
exist, weights are equal.
Run:  cd model && py -3.13 experiments/adaptive_combo.py
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
sys.path.insert(0, os.path.dirname(HERE)); sys.path.insert(0, HERE)
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import train as T  # noqa: E402
from data_pipeline import HORIZON, RICE_COLUMNS, SEQ_LEN, build_feature_frame, load_merged_frame, make_sequences  # noqa: E402
from mean_reversion import LSTM_DELTA_WEIGHT, rolling_phi  # noqa: E402
from arima_combo import arima_walk  # noqa: E402
from kalman_dow import kalman_forecasts  # noqa: E402

warnings.filterwarnings("ignore")
WINDOW = 30
WARM = 45          # forecast days computed before each scoring window so the first weights have history


def combine(fcs, true_p, window=WINDOW):
    """fcs: {name: (n, H)} forecasts over consecutive origins; true_p: (n, H) actuals.
    Row k's weights use errors from rows k-h-window .. k-h-1 (their targets are observed by origin k)."""
    names = list(fcs)
    n = true_p.shape[0]
    out = np.empty_like(true_p)
    for h in range(HORIZON):
        err2 = {m: (fcs[m][:, h] - true_p[:, h]) ** 2 for m in names}
        for k in range(n):
            hi = k - h                      # rows < hi have targets observed by origin k (target row + h <= k)
            lo = max(0, hi - window)
            if hi - lo >= 10:
                w = np.array([1.0 / max(err2[m][lo:hi].mean(), 1e-9) for m in names])
            else:
                w = np.ones(len(names))
            w /= w.sum()
            out[k, h] = sum(w[j] * fcs[m][k, h] for j, m in enumerate(names))
    return out


def main():
    import tensorflow as tf
    from keras_compat import apply_keras_load_compat
    apply_keras_load_compat()
    df = load_merged_frame()
    res = {}
    for target in RICE_COLUMNS:
        sub, feats = build_feature_frame(df, target)
        n_seq = len(sub) - SEQ_LEN - HORIZON + 1
        i_tr, i_va, _ = T._split_indices(sub, n_seq, target)
        s0 = i_tr + int(round(0.6 * (i_va - i_tr)))
        keras_path, scaler_path, _ = T._model_paths(target)
        scaler = joblib.load(scaler_path)
        X, y_level = make_sequences(scaler.transform(sub[feats].values.astype(float)), 0, SEQ_LEN, HORIZON)
        lstm = np.asarray(tf.keras.models.load_model(keras_path).predict(X[i_tr:], verbose=0))
        to_p = lambda v: (v - scaler.min_[0]) / scaler.scale_[0]
        y = pd.to_numeric(sub[target], errors="coerce").values.astype(float)
        dates = pd.to_datetime(sub["Date"], errors="coerce")
        dows = dates.dt.dayofweek.fillna(0).astype(int).values
        era0 = int(np.argmax(dates.values >= np.datetime64(T.ACTIVE_FROM)))
        out = {}
        for part, (a, z) in {"sel": (s0, i_va), "test": (i_va, n_seq)}.items():
            a0 = max(i_tr, a - WARM)                      # warm-up origins (their errors feed the first weights)
            idx = np.arange(a0, z)
            rows = idx + SEQ_LEN - 1
            true_p, anc = to_p(y_level[idx]), y[rows]
            lstm_p = LSTM_DELTA_WEIGHT * lstm[idx - i_tr] / scaler.scale_[0]
            corr = np.array([rolling_phi(y, r, HORIZON, dows=dows)[0][:, 0] * (y[r] - y[r - 1]) for r in rows])
            H = anc[:, None] + lstm_p + corr
            A = arima_walk(y, rows[0] + 1, rows[0] + 1, rows[-1] + 2)
            K1 = kalman_forecasts(y, dows, era0, rows, "K1") + lstm_p
            fc = {"H": H, "A": A, "K1": K1, "BG2": combine({"H": H, "A": A}, true_p),
                  "BG3": combine({"H": H, "A": A, "K1": K1}, true_p)}
            # Robustness only (disclosed, not used for choosing): other window lengths for BG3.
            for wl in (15, 20, 45, 60, 90):
                fc[f"BG3_w{wl}"] = combine({"H": H, "A": A, "K1": K1}, true_p, window=wl)
            keep = idx >= a                                # score only the real window
            tp, an = true_p[keep], anc[keep]
            naive = np.abs(tp - an[:, None]).mean()
            dirn = lambda v: float((np.sign(v[keep] - an[:, None]) == np.sign(tp - an[:, None]))[np.abs(tp - an[:, None]) > 1e-6].mean() * 100)
            out[part] = {k: {"mae": float(np.abs(tp - v[keep]).mean()),
                             "skill": float((naive - np.abs(tp - v[keep]).mean()) / naive * 100),
                             "dir": dirn(v)} for k, v in fc.items()}
        res[target] = out
        t = out["test"]
        print(f"  {target}: test skill H {t['H']['skill']:.2f}  A {t['A']['skill']:.2f}  BG2 {t['BG2']['skill']:.2f}  BG3 {t['BG3']['skill']:.2f}", flush=True)

    sel = {k: np.mean([res[t]["sel"][k]["skill"] for t in RICE_COLUMNS]) for k in ("BG2", "BG3")}
    chosen = max(sel, key=sel.get)
    print(f"\nselection mean skill: BG2 {sel['BG2']:.2f}  BG3 {sel['BG3']:.2f}  (H {np.mean([res[t]['sel']['H']['skill'] for t in RICE_COLUMNS]):.2f})")
    print(f"CHOSEN on selection: {chosen}\n")
    print(f"{'type':<14}{'ARIMA':>8}{'H':>8}{chosen:>8}   skill H -> {chosen}")
    for t in RICE_COLUMNS:
        te = res[t]["test"]
        print(f"{t:<14}{te['A']['mae']:>8.4f}{te['H']['mae']:>8.4f}{te[chosen]['mae']:>8.4f}   {te['H']['skill']:6.2f} -> {te[chosen]['skill']:6.2f}")
    for k in ("H", "BG2", "BG3", "K1", "BG3_w15", "BG3_w20", "BG3_w45", "BG3_w60", "BG3_w90"):
        te = [res[t]["test"] for t in RICE_COLUMNS]
        print(f"TEST {k:<4} beats ARIMA {sum(x[k]['mae'] < x['A']['mae'] for x in te)}/8  mean skill {np.mean([x[k]['skill'] for x in te]):5.2f}%  "
              f"worst {min(x[k]['skill'] for x in te):5.2f}%  directional {np.mean([x[k]['dir'] for x in te]):4.1f}%  {'<- chosen' if k == chosen else ''}")
    json.dump({"rows": res, "selection_mean_skill": sel, "chosen": chosen, "window": WINDOW},
              open(os.path.join(HERE, "adaptive_combo_results.json"), "w"), indent=1)


if __name__ == "__main__":
    main()

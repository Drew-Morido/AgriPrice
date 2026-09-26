"""
Experiment: does a DAY-OF-WEEK-aware mean-reversion coefficient beat the single global one?

Motivation (measured on the active regime, 2025-04-01 onward, all 8 types pooled): a price's distance
from its own week's median is ~PHP 0.12-0.15 on Mon-Wed bulletins, ~0.19 on Thu/Fri, 0.26 on Sat and
0.83 on Sun. DA's Sunday bulletin is compiled from fewer markets, and that noise is undone on Monday.
The shipped correction uses one coefficient for every day, so it under-corrects after a noisy
weekend reading and over-corrects after a Thursday/Friday move that is real.

Protocol (fixed before looking at test scores):
  - Same forecast as production: anchor + LSTM_DELTA_WEIGHT * lstm_delta + phi * last_change,
    using the trained networks in model/lstm_models, the same regime-aware split, and the same
    rolling, past-only re-fit.
  - Candidates:
      global    the current production rule (one phi per horizon, 120-day window)
      grp3/W    phi by weekday group of the last observed day: Mon-Wed | Thu-Fri | Sat-Sun
      dow7/W    one phi per weekday
    for rolling windows W in {120, 240, 365}. A group whose coefficient fails the |t| >= 2 gate falls
    back to the global coefficient, so a variant can never be worse than "no information" by design.
  - The candidate is chosen on the VALIDATION window (mean skill across the 8 types); only that one is
    then reported on the TEST window. All candidates' test scores are printed too, for disclosure.

Run:  cd model && py -3.13 experiments/weekday_reversion.py
"""

from __future__ import annotations

import os
import sys

import joblib
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.dirname(HERE)
sys.path.insert(0, MODEL_DIR)
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

from data_pipeline import HORIZON, SEQ_LEN, build_feature_frame, load_merged_frame, make_sequences  # noqa: E402
from mean_reversion import LSTM_DELTA_WEIGHT, MIN_ABS_T, SHRINK, rolling_phi  # noqa: E402
import train as T  # noqa: E402

GROUPS = {
    "grp3": lambda dow: 0 if dow <= 2 else (1 if dow <= 4 else 2),
    "dow7": lambda dow: dow,
}
WINDOWS = (120, 240, 365)


def _fit_group_phi(s, dows, start, end, horizon, group_of):
    """phi[g][h] from rows [start, end), OLS through the origin inside each weekday group."""
    out = {}
    for h in range(1, horizon + 1):
        xs, ys, gs = [], [], []
        for i in range(max(start, 1) + 1, min(end, len(s)) - h):
            d = s[i] - s[i - 1]
            y = s[i + h] - s[i]
            if np.isfinite(d) and np.isfinite(y):
                xs.append(d); ys.append(y); gs.append(group_of(dows[i]))
        xs, ys, gs = map(np.asarray, (xs, ys, gs))
        for g in np.unique(gs) if len(gs) else []:
            m = gs == g
            x, y = xs[m], ys[m]
            sxx = float((x * x).sum())
            if m.sum() < 12 or sxx <= 1e-12:
                continue
            b = float((x * y).sum() / sxx)
            resid = y - b * x
            se = np.sqrt(float((resid ** 2).sum()) / max(len(x) - 1, 1) / sxx)
            t = b / max(se, 1e-12)
            if b < 0 and abs(t) >= MIN_ABS_T:
                out.setdefault(int(g), [0.0] * horizon)[h - 1] = max(-1.0, min(0.0, b * SHRINK))
    return out


def _corrections(s, dows, rows, variant, window):
    """Peso correction per forecast row for one variant."""
    corr = np.zeros((len(rows), HORIZON))
    for k, r in enumerate(rows):
        d = s[r] - s[r - 1] if r >= 1 else 0.0
        d = 0.0 if not np.isfinite(d) else d
        phi_g, _ = rolling_phi(s, r, HORIZON)          # production rule, 120-day window
        base = phi_g[:, 0]
        if variant == "global":
            corr[k] = base * d
            continue
        group_of = GROUPS[variant]
        start = max(0, r - window)
        phis = _fit_group_phi(s, dows, start, r, HORIZON, group_of)
        g = group_of(dows[r])
        use = np.array([phis[g][h] if g in phis and phis[g][h] < 0 else base[h] for h in range(HORIZON)])
        corr[k] = use * d
    return corr


def _skill(y_true_p, pred_p, anchor_p):
    mae = np.abs(y_true_p - pred_p).mean()
    base = np.abs(y_true_p - anchor_p[:, None]).mean()
    return (base - mae) / base * 100 if base > 0 else 0.0, mae, base


def evaluate():
    import tensorflow as tf
    from keras_compat import apply_keras_load_compat
    apply_keras_load_compat()
    _load = tf.keras.models.load_model
    df = load_merged_frame()
    variants = [("global", 120)] + [(v, w) for v in GROUPS for w in WINDOWS]
    results = {v: {"val": [], "test": []} for v in variants}
    per_type = {}

    for target in T._training_target_list():
        sub, features = build_feature_frame(df, target)
        ti = features.index(target)
        raw = sub[features].values.astype(float)
        n_seq = len(raw) - SEQ_LEN - HORIZON + 1
        i_tr, i_va, _ = T._split_indices(sub, n_seq, target)
        keras_path, scaler_path, _ = T._model_paths(target)
        scaler = joblib.load(scaler_path)
        scaled = scaler.transform(raw)
        X, y_level = make_sequences(scaled, ti, SEQ_LEN, HORIZON)
        model = _load(keras_path)
        lstm = np.asarray(model.predict(X[i_tr:], verbose=0))
        scale, mn = scaler.scale_[ti], scaler.min_[ti]
        to_peso = lambda v: (v - mn) / scale
        s = pd.to_numeric(sub[target], errors="coerce").values.astype(float)
        dows = pd.to_datetime(sub["Date"]).dt.dayofweek.values
        per_type[target] = {}
        for split, (a, b) in {"val": (i_tr, i_va), "test": (i_va, n_seq)}.items():
            anchors = X[a:b, -1, ti]
            level = anchors[:, None] + LSTM_DELTA_WEIGHT * lstm[a - i_tr:b - i_tr]
            rows = np.arange(a + SEQ_LEN - 1, b + SEQ_LEN - 1)
            yt, an = to_peso(y_level[a:b]), to_peso(anchors)
            for v in variants:
                corr = _corrections(s, dows, rows, *v)
                sk, mae, base = _skill(yt, to_peso(level) + corr, an)
                results[v][split].append(sk)
                per_type[target][(v, split)] = round(sk, 2)
        print(f"  {target} done")

    print("\nmean skill vs naive (%), 8 types — chosen on VALIDATION, reported on TEST")
    print(f"{'variant':<14}{'val mean':>10}{'val worst':>11}{'test mean':>11}{'test worst':>12}{'test >0':>9}")
    for v in variants:
        va, te = np.array(results[v]["val"]), np.array(results[v]["test"])
        print(f"{v[0]+'/'+str(v[1]):<14}{va.mean():>10.2f}{va.min():>11.2f}{te.mean():>11.2f}{te.min():>12.2f}{(te>0).sum():>7}/8")
    best = max(variants, key=lambda v: np.mean(results[v]["val"]))
    print(f"\nchosen on validation: {best[0]}/{best[1]}")
    print(f"TEST  chosen {np.mean(results[best]['test']):.2f}%  vs  production global {np.mean(results[('global',120)]['test']):.2f}%")
    print("\nper type, TEST skill: production -> chosen")
    for t, d in per_type.items():
        print(f"  {t:<14} {d[(('global',120),'test')]:>6} -> {d[(best,'test')]}")
    return results, best


if __name__ == "__main__":
    evaluate()

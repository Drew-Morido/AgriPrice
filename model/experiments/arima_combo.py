"""
Experiment: can the system beat ARIMA(1,1,1) on more rice types?

Where it loses (meta.json): locSpecial +5.0%, impSpecial +4.5%, locWellMilled +1.2%, locPremium +0.3% MAE.
Diagnosis: our forecast is anchored on the LAST DA reading, and a single reading carries the day's
survey noise (strongest on Sundays and for Special rice). ARIMA(1,1,1)'s moving-average term acts as a
smoothed level, so it filters one-day noise.

Candidates (all use the saved production LSTMs and the production weekday reversion term; nothing is
retrained and nothing in production changes):
  H        the production hybrid: anchor + 0.25*LSTM + weekday reversion              (reference)
  A        ARIMA(1,1,1)                                                                (the baseline)
  C(w)     forecast combination  w*H + (1-w)*A,  w in {0.25, 0.5, 0.75}   ("ARIMA-LSTM hybrid")
  A+R      ARIMA plus the weekday reversion term (does ARIMA miss the Sunday effect?)
  S(a)     H re-anchored on an exponentially smoothed level instead of the last reading, a in {0.3, 0.5, 0.7}

Protocol (fixed before looking at test):
  - Choices are made on the VALIDATION block (production split). ARIMA for validation is fitted on
    training rows only; for test it is fitted on train+validation, exactly like the reported baseline.
  - One setting for all 8 types (chosen by mean validation MAE), then reported once on TEST.
    The per-type choice is also shown, labelled as such, because it has 8x the freedom.
Run:  cd model && py -3.13 experiments/arima_combo.py
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
from mean_reversion import LSTM_DELTA_WEIGHT, rolling_phi  # noqa: E402

warnings.filterwarnings("ignore")


def arima_walk(y, fit_end, first_origin, last_origin):
    """ARIMA(1,1,1) fitted on y[:fit_end], then walk-forward forecasts for origins [first, last)."""
    from statsmodels.tsa.arima.model import ARIMA
    res = ARIMA(y[:fit_end], order=(1, 1, 1)).fit()
    if first_origin > fit_end:
        res = res.append(y[fit_end:first_origin], refit=False)
    out = []
    for o in range(first_origin, last_origin):
        out.append(np.asarray(res.forecast(HORIZON), dtype=float))
        res = res.append(y[o:o + 1], refit=False)
    return np.array(out)


def smoothed_level(s, alpha):
    lvl = np.empty_like(s)
    lvl[0] = s[0]
    for i in range(1, len(s)):
        lvl[i] = alpha * s[i] + (1 - alpha) * lvl[i - 1]
    return lvl


def main():
    import tensorflow as tf
    from keras_compat import apply_keras_load_compat
    apply_keras_load_compat()
    df = load_merged_frame()
    rows = {}
    for target in RICE_COLUMNS:
        sub, feats = build_feature_frame(df, target)
        n_seq = len(sub) - SEQ_LEN - HORIZON + 1
        i_tr, i_va, _ = T._split_indices(sub, n_seq, target)
        keras_path, scaler_path, _ = T._model_paths(target)
        scaler = joblib.load(scaler_path)
        X, y_level = make_sequences(scaler.transform(sub[feats].values.astype(float)), 0, SEQ_LEN, HORIZON)
        lstm = np.asarray(tf.keras.models.load_model(keras_path).predict(X[i_tr:], verbose=0))
        to_p = lambda v: (v - scaler.min_[0]) / scaler.scale_[0]
        s = pd.to_numeric(sub[target], errors="coerce").values.astype(float)
        dows = pd.to_datetime(sub["Date"], errors="coerce").dt.dayofweek.fillna(0).astype(int).values
        out = {}
        for part, (a, z, fit_end) in {"val": (i_tr, i_va, i_tr + SEQ_LEN), "test": (i_va, n_seq, i_va + SEQ_LEN)}.items():
            idx = np.arange(a, z)
            anchor_rows = idx + SEQ_LEN - 1
            true_p = to_p(y_level[idx])
            anc = s[anchor_rows]
            corr = np.array([rolling_phi(s, r, HORIZON, dows=dows)[0][:, 0] * (s[r] - s[r - 1]) for r in anchor_rows])
            lstm_p = LSTM_DELTA_WEIGHT * lstm[idx - i_tr] / scaler.scale_[0]
            H = anc[:, None] + lstm_p + corr
            A = arima_walk(s, fit_end, anchor_rows[0] + 1, anchor_rows[-1] + 2)
            cand = {"H": H, "A": A, "A+R": A + corr}
            for w in (0.25, 0.5, 0.75):
                cand[f"C{w}"] = w * H + (1 - w) * A
            for al in (0.3, 0.5, 0.7):
                lvl = smoothed_level(s, al)[anchor_rows]
                cand[f"S{al}"] = lvl[:, None] + lstm_p + corr
            out[part] = {k: float(np.abs(true_p - v).mean()) for k, v in cand.items()}
            out[part]["naive"] = float(np.abs(true_p - anc[:, None]).mean())
        rows[target] = out
        print(f"  {target}: test H {out['test']['H']:.4f}  A {out['test']['A']:.4f}", flush=True)

    keys = [k for k in rows[RICE_COLUMNS[0]]["val"] if k not in ("A", "naive")]
    val_mean = {k: np.mean([rows[t]["val"][k] for t in RICE_COLUMNS]) for k in keys}
    chosen = min(val_mean, key=val_mean.get)
    print(f"\nvalidation mean MAE: " + ", ".join(f"{k} {v:.4f}" for k, v in sorted(val_mean.items(), key=lambda x: x[1])))
    print(f"CHOSEN on validation (one setting for all types): {chosen}\n")
    print(f"{'type':<14}{'ARIMA':>8}{'H (now)':>9}{chosen:>9}   beats ARIMA?  now -> chosen")
    b_now = b_new = 0
    for t in RICE_COLUMNS:
        te = rows[t]["test"]
        now, new = te["H"] < te["A"], te[chosen] < te["A"]
        b_now += now; b_new += new
        print(f"{t:<14}{te['A']:>8.4f}{te['H']:>9.4f}{te[chosen]:>9.4f}   {'yes' if now else 'no ':<4} -> {'yes' if new else 'no'}")
    sk = lambda k: np.mean([(rows[t]['test']['naive'] - rows[t]['test'][k]) / rows[t]['test']['naive'] * 100 for t in RICE_COLUMNS])
    print(f"\nbeats ARIMA: {b_now}/8 -> {b_new}/8 | mean skill vs naive: H {sk('H'):.2f}%  {chosen} {sk(chosen):.2f}%  ARIMA {sk('A'):.2f}%")
    per_type = {t: min(keys, key=lambda k: rows[t]["val"][k]) for t in RICE_COLUMNS}
    pt_beats = sum(rows[t]["test"][per_type[t]] < rows[t]["test"]["A"] for t in RICE_COLUMNS)
    print(f"(per-type choice on validation, 8x the freedom: {per_type} -> beats ARIMA {pt_beats}/8)")
    all_test = {k: {t: rows[t]["test"][k] for t in RICE_COLUMNS} for k in keys + ["A", "naive"]}
    json.dump({"rows": rows, "val_mean": val_mean, "chosen": chosen, "per_type_choice": per_type, "test": all_test},
              open(os.path.join(HERE, "arima_combo_results.json"), "w"), indent=1)


if __name__ == "__main__":
    main()

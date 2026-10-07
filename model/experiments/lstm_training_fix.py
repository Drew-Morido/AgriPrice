"""
Experiment (2026-10-07): fix the production LSTM's training so the network actually learns, and check — before
anything is deployed — that it does not lower the published accuracy.

The bug: production EarlyStopping uses min_delta=1e-4, but the delta-target loss is ~2e-3 and barely moves, so no
epoch ever counts as an improvement; every network stops at epoch 9 and restore_best_weights puts back its epoch-1
weights. Those weights output the same delta for every input (std across the 359 test forecasts = 0 for every type),
so no input — diesel, inflation, world rice, even the rice price itself — affects the network's output.

The fix (nothing else changes: same inputs, same architecture, same split, same weight 0.25, same reversion term,
same ensemble):
  - targets standardised per forecast day (divided by the training std, so the loss is ~1, not ~1e-3);
    the std is folded back into the last Dense layer afterwards, so the saved model outputs deltas exactly as before
  - EarlyStopping min_delta=0, patience 12

Protocol (fixed before looking at test):
  - Early stopping uses the first 60% of the production validation block; the GATE window is the last 40%.
  - Per rice type, the fixed network replaces the current one only if the hybrid's MAE on the GATE window is not
    higher than with the current network. Test plays no part in that decision.
  - Then, once, on the production TEST window: hybrid and ensemble skill vs naive, ARIMA wins, output spread, and
    a permutation check of each input (does shuffling it change the network's output?).

Nothing in production is touched: models live in memory only.
Run:  cd model && py -3.13 experiments/lstm_training_fix.py
"""

from __future__ import annotations

import json
import os
import sys
import time

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.dirname(HERE)
sys.path.insert(0, MODEL_DIR)
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")

import train as T  # noqa: E402
from data_pipeline import HORIZON, RICE_COLUMNS, SEQ_LEN, build_feature_frame, load_merged_frame, make_sequences  # noqa: E402
from mean_reversion import LSTM_DELTA_WEIGHT, rolling_phi  # noqa: E402

OUT = os.path.join(HERE, "lstm_training_fix.json")
GATE_FRACTION = 0.4


class Scaled:
    """Wraps a keras model trained on standardised targets so predict() returns deltas."""

    def __init__(self, model, sd):
        self.model, self.sd = model, sd

    def predict(self, X, verbose=0):
        return np.asarray(self.model.predict(X, verbose=0)) * self.sd


def make_model(n_feat):
    from keras.layers import Dense, Dropout, Input, LSTM
    from keras.models import Sequential
    m = Sequential([Input(shape=(SEQ_LEN, n_feat)), LSTM(64, return_sequences=True), Dropout(0.2),
                    LSTM(32), Dropout(0.2), Dense(16, activation="relu"), Dense(HORIZON)])
    m.compile(optimizer="adam", loss="mse")
    return m


def reversion(price, dows, rows):
    out = np.zeros((len(rows), HORIZON))
    for k, r in enumerate(rows):
        phi, _ = rolling_phi(price, r, HORIZON, dows=dows)
        lags = np.array([(price[r - j] - price[r - j - 1]) if r - j - 1 >= 0 else 0.0 for j in range(phi.shape[1])])
        out[k] = np.nan_to_num(lags) @ phi.T[:, :HORIZON]
    return out


def one_target(df, target):
    from keras.callbacks import EarlyStopping
    from keras.models import load_model
    from sklearn.preprocessing import MinMaxScaler

    T._seed_everything(T.SEED)
    sub, feats = build_feature_frame(df, target)
    ti = feats.index(target)
    raw = sub[feats].values.astype(float)
    n_seq = len(raw) - SEQ_LEN - HORIZON + 1
    i_tr, i_va, _ = T._split_indices(sub, n_seq, target)
    g0 = i_va - int(round(GATE_FRACTION * (i_va - i_tr)))          # gate window = [g0, i_va)
    scaler = MinMaxScaler().fit(raw[: i_tr + SEQ_LEN])
    X, y_level = make_sequences(scaler.transform(raw), ti, SEQ_LEN, HORIZON)
    anchors = X[:, -1, ti]
    y = y_level - anchors[:, None]
    scale, mn = scaler.scale_[ti], scaler.min_[ti]
    peso = lambda v: (np.asarray(v) - mn) / scale

    # ── fixed training ──
    sd = np.maximum(y[:i_tr].std(axis=0), 1e-9)
    net = make_model(len(feats))
    hist = net.fit(X[:i_tr], y[:i_tr] / sd, validation_data=(X[i_tr:g0], y[i_tr:g0] / sd), epochs=T.EPOCHS,
                   batch_size=T.BATCH_SIZE, verbose=0,
                   callbacks=[EarlyStopping(monitor="val_loss", patience=12, min_delta=0.0, restore_best_weights=True)])
    vl = hist.history["val_loss"]
    new = Scaled(net, sd)
    cur = load_model(os.path.join(MODEL_DIR, "lstm_models", f"{target}.keras"), compile=False)

    price = pd.to_numeric(sub[target], errors="coerce").values.astype(float)
    dows = pd.to_datetime(sub["Date"], errors="coerce").dt.dayofweek.values

    def hybrid(model, a, z):
        rows = np.arange(a, z) + SEQ_LEN - 1
        d = np.asarray(model.predict(X[a:z], verbose=0))
        return peso(anchors[a:z])[:, None] + LSTM_DELTA_WEIGHT * d / scale + reversion(price, dows, rows), d

    true = lambda a, z: peso(y_level[a:z])
    gate = {}
    for name, m in (("current", cur), ("fixed", new)):
        h, _ = hybrid(m, g0, i_va)
        gate[name] = float(np.abs(true(g0, i_va) - h).mean())
    use_fixed = gate["fixed"] <= gate["current"]

    # ── test, once ──
    base = float(np.abs(true(i_va, n_seq) - peso(anchors[i_va:n_seq])[:, None]).mean())
    arima = T._arima_baseline(sub[target].values.astype(float), i_va, SEQ_LEN, HORIZON)
    res = {"epochs": len(vl), "best_epoch": int(np.argmin(vl)) + 1, "gate_mae": {k: round(v, 4) for k, v in gate.items()},
           "gate_picks": "fixed" if use_fixed else "current", "arima_mae": round(arima["mae_peso"], 4) if arima else None}
    for name, m in (("current", cur), ("fixed", new)):
        h, d = hybrid(m, i_va, n_seq)
        ens, _ = T._ensemble_test_forecast(sub, price, scaler, ti, X, y_level, i_tr, i_va, h * scale + mn, m,
                                          "tensorflow", True)
        hm = float(np.abs(true(i_va, n_seq) - h).mean())
        em = float(np.abs(true(i_va, n_seq) - peso(ens)).mean())
        res[name] = {"hybrid_skill": round((1 - hm / base) * 100, 2), "ensemble_skill": round((1 - em / base) * 100, 2),
                     "hybrid_mae": round(hm, 4), "ensemble_mae": round(em, 4),
                     "output_std_peso": [round(float(v), 4) for v in (d / scale).std(axis=0)]}
    # permutation: shuffle one input across test samples, how far does the network's day-1 delta move (peso)?
    rng = np.random.default_rng(0)
    Xt = X[i_va:n_seq]
    d0 = new.predict(Xt)[:, 0] / scale
    perm = {}
    for j, f in enumerate(feats):
        Xp = Xt.copy()
        Xp[:, :, j] = Xp[rng.permutation(len(Xp)), :, j]
        perm[f] = round(float(np.abs(new.predict(Xp)[:, 0] / scale - d0).mean()), 4)
    res["fixed"]["permutation_day1_peso"] = perm
    return res


def main():
    t0 = time.time()
    df = load_merged_frame()
    report = {"protocol": __doc__.split("Protocol")[1].split("Nothing in production")[0].strip(), "types": {}}
    for t in RICE_COLUMNS:
        r = one_target(df, t)
        report["types"][t] = r
        print(f"{t}: epochs {r['epochs']} (best {r['best_epoch']}) gate {r['gate_mae']} -> {r['gate_picks']} | "
              f"ens cur {r['current']['ensemble_skill']} fixed {r['fixed']['ensemble_skill']} | "
              f"hyb cur {r['current']['hybrid_skill']} fixed {r['fixed']['hybrid_skill']} | std {r['fixed']['output_std_peso']}",
              flush=True)
        json.dump(report, open(OUT, "w"), indent=1)
    ty = report["types"]
    pick = lambda r: r["fixed"] if r["gate_picks"] == "fixed" else r["current"]
    summ = {}
    for label, sel in (("current", lambda r: r["current"]), ("fixed_all", lambda r: r["fixed"]), ("gated", pick)):
        summ[label] = {
            "ensemble_skill_mean": round(float(np.mean([sel(r)["ensemble_skill"] for r in ty.values()])), 2),
            "hybrid_skill_mean": round(float(np.mean([sel(r)["hybrid_skill"] for r in ty.values()])), 2),
            "ensemble_beats_arima": sum(sel(r)["ensemble_mae"] < r["arima_mae"] for r in ty.values()),
            "hybrid_beats_arima": sum(sel(r)["hybrid_mae"] < r["arima_mae"] for r in ty.values()),
        }
    report["summary"] = summ
    report["elapsed_s"] = int(time.time() - t0)
    json.dump(report, open(OUT, "w"), indent=1)
    print(json.dumps(summ, indent=1))


if __name__ == "__main__":
    main()

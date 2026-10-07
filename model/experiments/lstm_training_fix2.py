"""
Experiment (2026-10-07, the ONE follow-up to lstm_training_fix.py; declared to the team as the last attempt on this
test window): can a properly trained LSTM match or beat the current published forecast?

lstm_training_fix.py showed that fixing the training (standardised targets, min_delta=0, patience 12) makes the
network learn — the inputs now move its output — but lowers test accuracy (ensemble +10.32% -> +8.55%; +9.38% with
the validation gate; 7/8 vs ARIMA), worst on locSpecial, which the gate picked on a 0.0001 validation margin.
Two causes were named before this run, and one variant addressing both was fixed in advance:

  1. Loss weights: a training sequence whose first forecast day is a genuinely published daily DA price
     (rice_price_provenance: frequency 'daily' and at least half of the 8 cells published, or any day from
     2026-01-01, which comes from the DA Daily Price Index) counts 1.0; a day carried from a monthly/weekly figure
     counts 0.25. The network then stops learning the "no change" pattern of repeated monthly/weekly values.
  2. Seed averaging: 5 networks per rice type (seeds 42..46), predictions averaged — the standard remedy for a
     flexible model fitting noise on small data.
  Training otherwise as lstm_training_fix.py: same inputs, architecture, split, LSTM_DELTA_WEIGHT 0.25, weekday
  reversion term and adaptive ensemble.

Protocol (written before the run; test is looked at once):
  - Early stopping on the first 60% of the validation block; the GATE window is the last 40%.
  - Per rice type, the new network replaces the current one only if the hybrid's GATE-window MAE is at least 2%
    lower (new <= 0.98 x current). Test plays no part in it.
  - DEPLOY RULE: the gated result goes to production only if its mean ensemble skill on TEST is >= the current
    10.32% AND the ensemble still beats ARIMA on 8/8. Otherwise production stays as it is and this is reported as
    the eleventh approach tested and rejected. No further variants are run on this test window either way.

Nothing in production is touched: models live in memory only.
Run:  cd model && py -3.13 experiments/lstm_training_fix2.py
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.dirname(HERE)
sys.path.insert(0, MODEL_DIR)
sys.path.insert(0, HERE)
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")

import train as T  # noqa: E402
from data_pipeline import DB_PATH, HORIZON, RICE_COLUMNS, SEQ_LEN, build_feature_frame, load_merged_frame, make_sequences  # noqa: E402
from lstm_training_fix import make_model, reversion  # noqa: E402
from mean_reversion import LSTM_DELTA_WEIGHT  # noqa: E402

OUT = os.path.join(HERE, "lstm_training_fix2.json")
GATE_FRACTION = 0.4
GATE_MARGIN = 0.98
SEEDS = (42, 43, 44, 45, 46)
CARRIED_WEIGHT = 0.25
CURRENT_ENSEMBLE_SKILL = 10.32       # lstm_training_fix.json summary.current, same test window
DPI_FROM = pd.Timestamp("2026-01-01")


def genuine_daily_days() -> set:
    with sqlite3.connect(DB_PATH) as c:
        p = pd.read_sql("SELECT Date, frequency, published_cells FROM rice_price_provenance", c)
    p["Date"] = pd.to_datetime(p["Date"])
    return set(p.loc[(p["frequency"] == "daily") & (p["published_cells"] >= 4), "Date"])


class Averaged:
    """Average of several networks trained on standardised targets; predict() returns deltas."""

    def __init__(self, nets, sd):
        self.nets, self.sd = nets, sd

    def predict(self, X, verbose=0):
        return np.mean([np.asarray(n.predict(X, verbose=0)) for n in self.nets], axis=0) * self.sd


def one_target(df, target, genuine):
    from keras.callbacks import EarlyStopping
    from keras.models import load_model
    from sklearn.preprocessing import MinMaxScaler

    sub, feats = build_feature_frame(df, target)
    ti = feats.index(target)
    raw = sub[feats].values.astype(float)
    n_seq = len(raw) - SEQ_LEN - HORIZON + 1
    i_tr, i_va, _ = T._split_indices(sub, n_seq, target)
    g0 = i_va - int(round(GATE_FRACTION * (i_va - i_tr)))
    scaler = MinMaxScaler().fit(raw[: i_tr + SEQ_LEN])
    X, y_level = make_sequences(scaler.transform(raw), ti, SEQ_LEN, HORIZON)
    anchors = X[:, -1, ti]
    y = y_level - anchors[:, None]
    scale, mn = scaler.scale_[ti], scaler.min_[ti]
    peso = lambda v: (np.asarray(v) - mn) / scale

    first_day = pd.to_datetime(sub["Date"]).iloc[SEQ_LEN:SEQ_LEN + n_seq].reset_index(drop=True)
    is_genuine = first_day.apply(lambda d: d in genuine or d >= DPI_FROM).values
    w_train = np.where(is_genuine[:i_tr], 1.0, CARRIED_WEIGHT)

    sd = np.maximum(y[:i_tr].std(axis=0), 1e-9)
    nets, epochs = [], []
    for seed in SEEDS:
        T._seed_everything(seed)
        net = make_model(len(feats))
        h = net.fit(X[:i_tr], y[:i_tr] / sd, sample_weight=w_train, validation_data=(X[i_tr:g0], y[i_tr:g0] / sd),
                    epochs=T.EPOCHS, batch_size=T.BATCH_SIZE, verbose=0,
                    callbacks=[EarlyStopping(monitor="val_loss", patience=12, min_delta=0.0, restore_best_weights=True)])
        nets.append(net)
        epochs.append(len(h.history["val_loss"]))
    new = Averaged(nets, sd)
    cur = load_model(os.path.join(MODEL_DIR, "lstm_models", f"{target}.keras"), compile=False)

    price = pd.to_numeric(sub[target], errors="coerce").values.astype(float)
    dows = pd.to_datetime(sub["Date"], errors="coerce").dt.dayofweek.values

    def hybrid(model, a, z):
        rows = np.arange(a, z) + SEQ_LEN - 1
        d = np.asarray(model.predict(X[a:z], verbose=0))
        return peso(anchors[a:z])[:, None] + LSTM_DELTA_WEIGHT * d / scale + reversion(price, dows, rows), d

    true = lambda a, z: peso(y_level[a:z])
    gate = {}
    for name, m in (("current", cur), ("new", new)):
        h, _ = hybrid(m, g0, i_va)
        gate[name] = float(np.abs(true(g0, i_va) - h).mean())
    use_new = gate["new"] <= GATE_MARGIN * gate["current"]

    base = float(np.abs(true(i_va, n_seq) - peso(anchors[i_va:n_seq])[:, None]).mean())
    arima = T._arima_baseline(sub[target].values.astype(float), i_va, SEQ_LEN, HORIZON)
    res = {"epochs": epochs, "genuine_train_share_pct": round(float(is_genuine[:i_tr].mean() * 100), 1),
           "gate_mae": {k: round(v, 4) for k, v in gate.items()}, "gate_picks": "new" if use_new else "current",
           "arima_mae": round(arima["mae_peso"], 4) if arima else None}
    for name, m in (("current", cur), ("new", new)):
        h, d = hybrid(m, i_va, n_seq)
        ens, _ = T._ensemble_test_forecast(sub, price, scaler, ti, X, y_level, i_tr, i_va, h * scale + mn, m,
                                          "tensorflow", True)
        hm = float(np.abs(true(i_va, n_seq) - h).mean())
        em = float(np.abs(true(i_va, n_seq) - peso(ens)).mean())
        res[name] = {"hybrid_skill": round((1 - hm / base) * 100, 2), "ensemble_skill": round((1 - em / base) * 100, 2),
                     "hybrid_mae": round(hm, 4), "ensemble_mae": round(em, 4),
                     "output_std_peso": [round(float(v), 4) for v in (d / scale).std(axis=0)]}
    rng = np.random.default_rng(0)
    Xt = X[i_va:n_seq]
    d0 = new.predict(Xt)[:, 0] / scale
    perm = {}
    for j, f in enumerate(feats):
        Xp = Xt.copy()
        Xp[:, :, j] = Xp[rng.permutation(len(Xp)), :, j]
        perm[f] = round(float(np.abs(new.predict(Xp)[:, 0] / scale - d0).mean()), 4)
    res["new"]["permutation_day1_peso"] = perm
    return res


def main():
    t0 = time.time()
    df = load_merged_frame()
    genuine = genuine_daily_days()
    report = {"protocol": __doc__.split("Protocol")[1].split("Nothing in production")[0].strip(), "types": {}}
    for t in RICE_COLUMNS:
        r = one_target(df, t, genuine)
        report["types"][t] = r
        print(f"{t}: epochs {r['epochs']} genuine {r['genuine_train_share_pct']}% gate {r['gate_mae']} -> {r['gate_picks']} | "
              f"ens cur {r['current']['ensemble_skill']} new {r['new']['ensemble_skill']} | "
              f"hyb cur {r['current']['hybrid_skill']} new {r['new']['hybrid_skill']} | std {r['new']['output_std_peso']}",
              flush=True)
        json.dump(report, open(OUT, "w"), indent=1)
    ty = report["types"]
    pick = lambda r: r["new"] if r["gate_picks"] == "new" else r["current"]
    summ = {}
    for label, sel in (("current", lambda r: r["current"]), ("new_all", lambda r: r["new"]), ("gated", pick)):
        summ[label] = {
            "ensemble_skill_mean": round(float(np.mean([sel(r)["ensemble_skill"] for r in ty.values()])), 2),
            "hybrid_skill_mean": round(float(np.mean([sel(r)["hybrid_skill"] for r in ty.values()])), 2),
            "ensemble_beats_arima": sum(sel(r)["ensemble_mae"] < r["arima_mae"] for r in ty.values()),
            "hybrid_beats_arima": sum(sel(r)["hybrid_mae"] < r["arima_mae"] for r in ty.values()),
        }
    g = summ["gated"]
    report["summary"] = summ
    report["deploy"] = bool(g["ensemble_skill_mean"] >= CURRENT_ENSEMBLE_SKILL and g["ensemble_beats_arima"] == 8)
    report["elapsed_s"] = int(time.time() - t0)
    json.dump(report, open(OUT, "w"), indent=1)
    print(json.dumps(summ, indent=1))
    print("DEPLOY:", report["deploy"])


if __name__ == "__main__":
    main()

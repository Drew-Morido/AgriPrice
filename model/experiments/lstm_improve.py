"""
Experiment: can the LSTM itself earn a measurable share of the forecast?

Diagnosis (see PAPER_CORRECTIONS.md): under the production split the network TRAINS only on
2015-01 -> 2025-03-31, which is weekly DA data forward-filled to daily (~80% "no change" rows). Every
genuinely daily day (2025-04 onward) is held out for validation/test, so the LSTM has never seen
the regime it is scored on. It also cannot see the weekday, which is where the Sunday-bulletin
effect lives, and each rice type has its own network with only ~540 daily days to learn from.

Variants (each adds one change to the previous):
  V0  production setup (reference)
  V1  training also includes the first 60% of the daily-era validation block
  V2  V1 + features: weekday (sin/cos), is-Sunday, is-Monday, last daily change, distance from the
      7-day median
  V3  V2 + older weekly-era training examples weighted 0.25 (daily-era examples 1.0)
  V4  V3 with ONE network shared by all 8 rice types (+ a rice-type one-hot): ~8x the daily data
  V5  (added after V0-V4 were declared, disclosed as such) V4, but the network is trained on the
      RESIDUAL of the weekday reversion forecast, i.e. only what the statistical term misses:
          forecast = anchor + reversion term + w * lstm_residual
  V6-V8 (added after V0-V5 revealed a training bug, disclosed as such): production EarlyStopping uses
      min_delta=1e-4, but the delta-target loss is only ~7e-4, so no improvement ever counts and every
      network stops at epoch 9 with its epoch-1 weights. V6-V8 standardise the targets (divide by
      the training std per horizon, so the loss is ~1) and use min_delta=0, patience 12:
      V6 = V2 + fixed training (per type), V7 = V6 pooled over 8 types, V8 = V7 on the residual (as V5).

Protocol (fixed before looking at test):
  - TEST window identical to production (sequences from the production i_va onward).
  - SELECTION window = last 40% of the production validation block. It is validation data for every
    variant (never test), and is the early-stopping set for V1-V4.
  - For every variant the forecast is combined exactly like production:
        anchor + w * lstm_delta (+ weekday reversion term, on or off),  w in {0.25, 0.5, 1.0}
    The (variant, w, reversion) with the best mean SELECTION skill is chosen and reported once on TEST.
  - Does the network contribute? On TEST, the chosen forecast vs the reversion-only forecast (w = 0):
      * paired error test: share of forecasts where the LSTM lowers the absolute error (sign test)
      * McNemar directional test on genuine-signal forecasts (same rule as train.py _lstm_ablation)
  - Seeded (AGRIPRICE_SEED); one seed per variant. Differences under ~0.5 pp skill are noise.

Nothing in production is touched: models live in memory only.
Run:  cd model && py -3.13 experiments/lstm_improve.py            (~1-1.5 h on CPU)
"""

from __future__ import annotations

import json
import math
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
from mean_reversion import rolling_phi  # noqa: E402

OUT = os.path.join(HERE, "lstm_improve_results.json")
WEIGHTS = (0.25, 0.5, 1.0)
OLD_WEIGHT = 0.25
EXTRA = ["dow_sin", "dow_cos", "is_sun", "is_mon", "d1", "dev7"]


# ─────────────────────────── data ───────────────────────────

def prepare(df, target, extra):
    sub, feats = build_feature_frame(df, target)
    if extra:
        d = pd.to_datetime(sub["Date"], errors="coerce")
        dow = d.dt.dayofweek.fillna(0).astype(float)
        t = pd.to_numeric(sub[target], errors="coerce")
        sub["dow_sin"] = np.sin(2 * np.pi * dow / 7)
        sub["dow_cos"] = np.cos(2 * np.pi * dow / 7)
        sub["is_sun"] = (dow == 6).astype(float)
        sub["is_mon"] = (dow == 0).astype(float)
        sub["d1"] = t.diff().fillna(0.0)
        sub["dev7"] = (t - t.rolling(7, min_periods=1).median()).fillna(0.0)
        feats = feats + EXTRA
    return sub, feats


def split_rows(sub, target):
    raw_n = len(sub)
    n_seq = raw_n - SEQ_LEN - HORIZON + 1
    i_tr, i_va, _ = T._split_indices(sub, n_seq, target)
    s0 = i_tr + int(round(0.6 * (i_va - i_tr)))       # selection window = [s0, i_va)
    return n_seq, i_tr, i_va, s0


def build_target(df, target, variant):
    from sklearn.preprocessing import MinMaxScaler
    sub, feats = prepare(df, target, variant["extra"])
    n_seq, i_tr, i_va, s0 = split_rows(sub, target)
    fit_end = s0 if variant["active_train"] else i_tr   # rows the scaler may see
    raw = sub[feats].values.astype(float)
    scaler = MinMaxScaler().fit(raw[: fit_end + SEQ_LEN])
    scaled = scaler.transform(raw)
    X, y_level = make_sequences(scaled, 0, SEQ_LEN, HORIZON)
    anchors = X[:, -1, 0]
    y = y_level - anchors[:, None]
    blk_series = pd.to_numeric(sub[target], errors="coerce").values.astype(float)
    blk_dows = pd.to_datetime(sub["Date"], errors="coerce").dt.dayofweek.fillna(0).astype(int).values
    if variant.get("residual"):
        # Train on what the reversion forecast gets wrong (past-only coefficient for every row).
        corr_all = reversion_corr({"series": blk_series, "dows": blk_dows}, np.arange(n_seq))
        y = y - corr_all * scaler.scale_[0]
    dates = pd.to_datetime(sub["Date"], errors="coerce").iloc[SEQ_LEN:SEQ_LEN + n_seq].reset_index(drop=True)
    return {
        "target": target, "sub": sub, "feats": feats, "scaler": scaler, "X": X, "y": y,
        "y_level": y_level, "anchors": anchors, "dates": dates,
        "n_seq": n_seq, "i_tr": i_tr, "i_va": i_va, "s0": s0,
        "series": blk_series,
        "dows": blk_dows,
    }


def train_slices(b, variant):
    """(train idx, early-stop idx) for one target."""
    if variant["active_train"]:
        return np.arange(0, b["s0"]), np.arange(b["s0"], b["i_va"])
    return np.arange(0, b["i_tr"]), np.arange(b["i_tr"], b["i_va"])


def sample_weights(b, idx, variant):
    if not variant.get("weight_old"):
        return None
    old = (b["dates"].iloc[idx] < pd.Timestamp(T.ACTIVE_FROM)).values
    return np.where(old, OLD_WEIGHT, 1.0)


# ─────────────────────────── model ───────────────────────────

def make_model(n_feat):
    from keras.layers import Dense, Dropout, LSTM, Input
    from keras.models import Sequential
    model = Sequential([
        Input(shape=(SEQ_LEN, n_feat)),
        LSTM(64, return_sequences=True), Dropout(0.2),
        LSTM(32), Dropout(0.2),
        Dense(16, activation="relu"), Dense(HORIZON),
    ])
    model.compile(optimizer="adam", loss="mse")
    return model


def fit(model, Xtr, ytr, wtr, Xva, yva, variant=None):
    """Returns (model, target_sd). With std_target the net learns y / sd and predictions are scaled back."""
    from keras.callbacks import EarlyStopping
    variant = variant or {}
    sd = np.ones(ytr.shape[1])
    if variant.get("std_target"):
        sd = np.maximum(ytr.std(axis=0), 1e-6)
    es = EarlyStopping(monitor="val_loss", patience=variant.get("patience", 8), min_delta=variant.get("min_delta", 1e-4),
                       restore_best_weights=True)
    hist = model.fit(Xtr, ytr / sd, sample_weight=wtr, validation_data=(Xva, yva / sd), epochs=T.EPOCHS,
                     batch_size=T.BATCH_SIZE, callbacks=[es], verbose=0)
    model._epochs_run = len(hist.history.get("loss", []))
    return model, sd


def with_onehot(X, k):
    oh = np.zeros((X.shape[0], X.shape[1], len(RICE_COLUMNS)))
    oh[:, :, k] = 1.0
    return np.concatenate([X, oh], axis=2)


# ─────────────────────────── scoring ───────────────────────────

def reversion_corr(b, rows_seq):
    s, dows = b["series"], b["dows"]
    out = np.zeros((len(rows_seq), HORIZON))
    for k, i in enumerate(rows_seq):
        r = i + SEQ_LEN - 1
        phi, _ = rolling_phi(s, r, HORIZON, dows=dows)
        d = s[r] - s[r - 1]
        out[k] = phi[:, 0] * (d if np.isfinite(d) else 0.0)
    return out


def peso(b, v):
    sc = b["scaler"]
    return (v - sc.min_[0]) / sc.scale_[0]


def score(b, idx, lstm_scaled, corr_peso, w, use_rev):
    anchors = b["anchors"][idx]
    pred = anchors[:, None] + w * lstm_scaled
    pred_p = peso(b, pred) + (corr_peso if use_rev else 0.0)
    true_p = peso(b, b["y_level"][idx])
    anc_p = peso(b, anchors)
    mae = np.abs(true_p - pred_p).mean()
    base = np.abs(true_p - anc_p[:, None]).mean()
    return (base - mae) / base * 100 if base > 0 else 0.0, pred_p, true_p, anc_p


def mcnemar(full_p, rev_p, true_p, anc_p, last_d):
    true_d = true_p - anc_p[:, None]
    full_d = full_p - anc_p[:, None]
    rev_d = rev_p - anc_p[:, None]
    signal = (np.abs(true_d) > 1e-6) & (np.abs(last_d)[:, None] > 1e-9) & (np.abs(rev_d) > 1e-12)
    okf = np.sign(full_d[signal]) == np.sign(true_d[signal])
    okr = np.sign(rev_d[signal]) == np.sign(true_d[signal])
    fixes, breaks = int((~okr & okf).sum()), int((okr & ~okf).sum())
    n = fixes + breaks
    chi2 = (abs(fixes - breaks) - 1) ** 2 / n if n else 0.0
    return {"fixes": fixes, "breaks": breaks, "p": float(f"{math.erfc(math.sqrt(chi2 / 2)):.4g}") if n else 1.0,
            "dir_full": round(float(okf.mean() * 100), 1), "dir_rev": round(float(okr.mean() * 100), 1)}


def sign_test(full_p, rev_p, true_p):
    ef, er = np.abs(true_p - full_p).ravel(), np.abs(true_p - rev_p).ravel()
    better, worse = int((ef < er - 1e-9).sum()), int((ef > er + 1e-9).sum())
    n = better + worse
    z = (abs(better - worse) - 1) / math.sqrt(n) if n else 0.0
    return {"lstm_lower_error": better, "lstm_higher_error": worse,
            "share_better_pct": round(100 * better / n, 1) if n else 0.0,
            "p": float(f"{math.erfc(max(z, 0) / math.sqrt(2)):.4g}") if n else 1.0}


# ─────────────────────────── run ───────────────────────────

VARIANTS = [
    {"name": "V0_production", "active_train": False, "extra": False, "weight_old": False, "pooled": False},
    {"name": "V1_active_in_train", "active_train": True, "extra": False, "weight_old": False, "pooled": False},
    {"name": "V2_plus_weekday_features", "active_train": True, "extra": True, "weight_old": False, "pooled": False},
    {"name": "V3_plus_weight_old", "active_train": True, "extra": True, "weight_old": True, "pooled": False},
    {"name": "V4_pooled_8_types", "active_train": True, "extra": True, "weight_old": True, "pooled": True},
    {"name": "V5_pooled_residual", "active_train": True, "extra": True, "weight_old": True, "pooled": True, "residual": True},
    {"name": "V6_fixed_training", "active_train": True, "extra": True, "weight_old": False, "pooled": False,
     "std_target": True, "min_delta": 0.0, "patience": 12},
    {"name": "V7_fixed_pooled", "active_train": True, "extra": True, "weight_old": False, "pooled": True,
     "std_target": True, "min_delta": 0.0, "patience": 12},
    {"name": "V8_fixed_pooled_residual", "active_train": True, "extra": True, "weight_old": False, "pooled": True,
     "residual": True, "std_target": True, "min_delta": 0.0, "patience": 12},
]


def run_variant(df, variant, seed=None):
    # Pass the seed explicitly: _seed_everything's default argument is bound when train.py is imported.
    T._seed_everything(T.SEED if seed is None else seed)
    blocks = [build_target(df, t, variant) for t in RICE_COLUMNS]
    preds = {}
    if variant["pooled"]:
        Xtr, ytr, wtr, Xva, yva = [], [], [], [], []
        for k, b in enumerate(blocks):
            tr, va = train_slices(b, variant)
            Xtr.append(with_onehot(b["X"][tr], k)); ytr.append(b["y"][tr])
            w = sample_weights(b, tr, variant)
            wtr.append(w if w is not None else np.ones(len(tr)))
            Xva.append(with_onehot(b["X"][va], k)); yva.append(b["y"][va])
        model = make_model(Xtr[0].shape[2])
        model, sd = fit(model, np.concatenate(Xtr), np.concatenate(ytr), np.concatenate(wtr), np.concatenate(Xva), np.concatenate(yva), variant)
        print(f"    {variant['name']} pooled model trained ({model._epochs_run} epochs)", flush=True)
        for k, b in enumerate(blocks):
            preds[b["target"]] = np.asarray(model.predict(with_onehot(b["X"], k), verbose=0)) * sd
    else:
        for b in blocks:
            tr, va = train_slices(b, variant)
            model = make_model(b["X"].shape[2])
            model, sd = fit(model, b["X"][tr], b["y"][tr], sample_weights(b, tr, variant), b["X"][va], b["y"][va], variant)
            preds[b["target"]] = np.asarray(model.predict(b["X"], verbose=0)) * sd
            print(f"    {variant['name']} {b['target']} trained ({model._epochs_run} epochs)", flush=True)
    return blocks, preds


def evaluate(blocks, preds):
    """Skill per (w, use_rev) on selection and test, plus the pieces for the ablation."""
    res = {}
    cache = {}
    for b in blocks:
        for part, (a, z) in {"sel": (b["s0"], b["i_va"]), "test": (b["i_va"], b["n_seq"])}.items():
            idx = np.arange(a, z)
            cache[(b["target"], part)] = (idx, reversion_corr(b, idx))
    for use_rev in (True, False):
        for w in (0.0,) + WEIGHTS:
            if w == 0.0 and not use_rev:
                continue
            key = f"w{w}_{'rev' if use_rev else 'norev'}"
            res[key] = {"sel": [], "test": []}
            for b in blocks:
                for part in ("sel", "test"):
                    idx, corr = cache[(b["target"], part)]
                    sk, *_ = score(b, idx, preds[b["target"]][idx], corr, w, use_rev)
                    res[key][part].append(round(float(sk), 2))
    return res, cache


def ablation(blocks, preds, cache, w, use_rev):
    F, R, Y, A, D = [], [], [], [], []
    for b in blocks:
        idx, corr = cache[(b["target"], "test")]
        _, full_p, true_p, anc_p = score(b, idx, preds[b["target"]][idx], corr, w, use_rev)
        _, rev_p, _, _ = score(b, idx, preds[b["target"]][idx], corr, 0.0, True)
        s = b["series"]
        last_d = np.array([s[i + SEQ_LEN - 1] - s[i + SEQ_LEN - 2] for i in idx])
        F.append(full_p); R.append(rev_p); Y.append(true_p); A.append(anc_p); D.append(last_d)
    F, R, Y, A, D = map(np.concatenate, (F, R, Y, A, D))
    return {"mcnemar_directional": mcnemar(F, R, Y, A, D), "paired_error_sign_test": sign_test(F, R, Y)}


def main():
    t0 = time.time()
    df = load_merged_frame()
    only = [a for a in sys.argv[1:] if a.startswith("V")]
    report = {"protocol": __doc__.split("Protocol")[1].split("Nothing in production")[0].strip(), "variants": {}}
    if only and os.path.exists(OUT):
        report = json.load(open(OUT))
    for v in VARIANTS:
        if only and not any(v["name"].startswith(o) for o in only):
            continue
        print(f"== {v['name']}", flush=True)
        blocks, preds = run_variant(df, v)
        res, cache = evaluate(blocks, preds)
        cands = [k for k in res if not k.startswith("w0.0") and (k.endswith("_rev") or not v.get("residual"))]
        best_key = max(cands, key=lambda k: np.mean(res[k]["sel"]))
        w = float(best_key.split("_")[0][1:]); use_rev = best_key.endswith("_rev")
        entry = {
            "configs": {k: {"sel_mean": round(float(np.mean(x["sel"])), 2), "test_mean": round(float(np.mean(x["test"])), 2),
                            "test_min": min(x["test"]), "test_per_type": dict(zip(RICE_COLUMNS, x["test"]))}
                        for k, x in res.items()},
            "best_on_selection": best_key,
            "ablation_test_vs_reversion_only": ablation(blocks, preds, cache, w, use_rev),
            "lstm_only_test_mean": round(float(np.mean(res["w1.0_norev"]["test"])), 2),
        }
        report["variants"][v["name"]] = entry
        b = entry["configs"][best_key]
        print(f"   best on selection: {best_key}  sel {b['sel_mean']}  TEST {b['test_mean']} (min {b['test_min']})"
              f" | reversion-only TEST {entry['configs']['w0.0_rev']['test_mean']} | LSTM-only TEST {entry['lstm_only_test_mean']}"
              f" | ablation {entry['ablation_test_vs_reversion_only']}", flush=True)
        json.dump(report, open(OUT, "w"), indent=1)
    winner = max(report["variants"], key=lambda k: report["variants"][k]["configs"][report["variants"][k]["best_on_selection"]]["sel_mean"])
    report["winner_on_selection"] = winner
    json.dump(report, open(OUT, "w"), indent=1)
    print(f"\nwinner (chosen on selection): {winner}   elapsed {int(time.time() - t0)}s")


if __name__ == "__main__":
    main()

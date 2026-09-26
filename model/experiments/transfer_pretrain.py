"""
Experiment: can the LSTM contribute if it first learns daily price behaviour from OTHER commodities?

Diagnosis (PAPER_CORRECTIONS.md): the network has only ~540 genuinely daily rice days; 2015-2024 are weekly
readings carried forward. Nine rice-only configurations failed to beat the statistical reversion term. The DA
Daily Price Index bulletins, however, report ~200 commodities every day (corn, fish, beef, pork, poultry,
vegetables, fruit) from the same markets and survey, with the same weekday effects.

Design (fixed before looking at results):
  - Extract every commodity from the daily bulletins (position-based, like tools/pdfconvrt.py).
  - PRE-TRAIN on non-rice commodities, dates 2025-04-01 .. the rice selection-window start (2025-07-22), so
    pre-training never sees the selection or test period (no leakage into choosing or scoring).
  - Inputs per day, all scale-free: last daily change and distance from the 7-day median (both divided by the
    series' own std of daily changes over the pre-training window), weekday sin/cos, is-Sunday, is-Monday, and
    the daily change of diesel and of the USD/PHP rate (the multivariate drivers). Target: the next 3 daily
    changes, same scaling. SEQ_LEN 30, HORIZON 3.
  - FINE-TUNE per rice type on its daily-era rows before the selection window (lower learning rate).
    Also scored: the pre-trained network with no fine-tuning ("zero-shot").
  - Forecast = anchor + w * network delta (+ weekday reversion), w in {0.25, 0.5, 1.0}, reversion on/off.
    (variant, w, reversion) chosen on the SELECTION window, reported once on TEST — the same protocol, windows and
    scoring as experiments/lstm_improve.py (reversion-only benchmark: +7.90% test skill).
  - The chosen configuration is re-run with 3 more seeds (a single lucky seed fooled us once already: V7).
Run:  cd model && py -3.13 experiments/transfer_pretrain.py
"""

from __future__ import annotations

import glob
import json
import math
import os
import re
import sys
from datetime import datetime

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.dirname(HERE)
ROOT = os.path.dirname(MODEL_DIR)
sys.path.insert(0, MODEL_DIR); sys.path.insert(0, HERE)
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")

import train as T  # noqa: E402
from data_pipeline import HORIZON, RICE_COLUMNS, SEQ_LEN, build_feature_frame, load_merged_frame  # noqa: E402
from mean_reversion import rolling_phi  # noqa: E402
from lstm_improve import mcnemar, sign_test  # noqa: E402

DPI_DIR = os.path.join(ROOT, "tools", "debug_fetch", "dpi")
PANEL_CACHE = os.path.join(HERE, "dpi_panel.parquet")
OUT = os.path.join(HERE, "transfer_results.json")
PRE_START = "2025-04-01"
FEATS = ["d1", "dev7", "dow_sin", "dow_cos", "is_sun", "is_mon", "fuel_d", "fx_d"]
_PRICE = re.compile(r"^\d{1,4}(?:,\d{3})*\.\d{2}$")
_MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December"


# ─────────────────────────── extraction ───────────────────────────

def extract_all(path):
    """{section|label: price} for every commodity in one bulletin, and the printed date."""
    import pdfplumber
    out, day = {}, None
    with pdfplumber.open(path) as pdf:
        text = pdf.pages[0].extract_text() or ""
        m = re.search(rf"({_MONTHS})\s+(\d{{1,2}}),\s*(\d{{4}})", text)
        if m:
            day = datetime.strptime(" ".join(m.groups()), "%B %d %Y").date().isoformat()
        section = ""
        for page in pdf.pages:
            words = page.extract_words() or []
            prices = [w for w in words if _PRICE.match(w["text"]) and w["x0"] > 420]
            labels = sorted([w for w in words if w not in prices and w["x0"] < 440], key=lambda w: (w["top"], w["x0"]))
            rows = []
            for w in labels:
                if rows and abs(rows[-1]["top"] - w["top"]) <= 2:
                    rows[-1]["words"].append(w); rows[-1]["bottom"] = max(rows[-1]["bottom"], w["bottom"])
                else:
                    rows.append({"top": w["top"], "bottom": w["bottom"], "words": [w]})
            info = []
            for r in rows:
                txt = " ".join(x["text"] for x in sorted(r["words"], key=lambda x: x["x0"])).strip()
                if not txt or any(k in txt for k in ("PREVAILING", "COMMODITY", "Page ", "UNIT (P/UNIT)", "RETAIL PRICE")):
                    continue
                if txt.isupper() and not any(ch.isdigit() for ch in txt) and len(txt) > 5:
                    section = re.sub(r"^[A-Z]\.?\s+", "", txt)      # "D. FISH" -> "FISH": enumerators shift between days
                    continue
                label = re.sub(r"^\d+\.?\s+", "", txt)             # "17 Tilapia ..." -> "Tilapia ..."
                info.append({"centre": (r["top"] + r["bottom"]) / 2, "key": f"{section}|{label}".lower()})
            for p in prices:
                c = (p["top"] + p["bottom"]) / 2
                if not info:
                    continue
                best = min(info, key=lambda i: abs(i["centre"] - c))
                if abs(best["centre"] - c) <= 9 and best["key"] not in out:
                    out[best["key"]] = float(p["text"].replace(",", ""))
    return day, out


def build_panel():
    if os.path.exists(PANEL_CACHE):
        return pd.read_parquet(PANEL_CACHE)
    recs = {}
    # Only the pre-2025-10-07 bulletins are needed (pre-training must end before the test window).
    for f in sorted(glob.glob(os.path.join(DPI_DIR, "2025-*.pdf"))):
        try:
            day, vals = extract_all(f)
        except Exception:
            continue
        if day:
            recs[day] = vals
    panel = pd.DataFrame.from_dict(recs, orient="index").sort_index()
    panel.index = pd.to_datetime(panel.index)
    panel.to_parquet(PANEL_CACHE)
    return panel


# ─────────────────────────── features ───────────────────────────

def features(s: pd.Series, drivers: pd.DataFrame, sd: float) -> pd.DataFrame:
    """Scale-free daily features for one price series (index = consecutive calendar days)."""
    f = pd.DataFrame(index=s.index)
    f["d1"] = s.diff() / sd
    f["dev7"] = (s - s.rolling(7, min_periods=3).median()) / sd
    dow = s.index.dayofweek
    f["dow_sin"], f["dow_cos"] = np.sin(2 * np.pi * dow / 7), np.cos(2 * np.pi * dow / 7)
    f["is_sun"], f["is_mon"] = (dow == 6).astype(float), (dow == 0).astype(float)
    f["fuel_d"] = drivers["fuel_d"].reindex(s.index).values
    f["fx_d"] = drivers["fx_d"].reindex(s.index).values
    return f.fillna(0.0)


def windows(f: pd.DataFrame, s: pd.Series, sd: float, start, end):
    """(X, y, anchor dates) for anchors in [start, end]."""
    X, Y, D = [], [], []
    v, fv, idx = s.values, f.values, s.index
    for i in range(SEQ_LEN - 1, len(s) - HORIZON):
        if not (start <= idx[i] <= end):
            continue
        tgt = v[i + 1:i + 1 + HORIZON] - v[i]
        if not np.all(np.isfinite(tgt)) or not np.all(np.isfinite(fv[i - SEQ_LEN + 1:i + 1])):
            continue
        X.append(fv[i - SEQ_LEN + 1:i + 1]); Y.append(tgt / sd); D.append(idx[i])
    return np.array(X), np.array(Y), D


def drivers_frame(df):
    d = df.set_index(pd.to_datetime(df["Date"]))
    fuel = pd.to_numeric(d["fuel_diesel"], errors="coerce").ffill()
    fx = pd.to_numeric(d["exchange"], errors="coerce").ffill()
    return pd.DataFrame({"fuel_d": fuel.diff() / max(fuel.diff().std(), 1e-6),
                         "fx_d": fx.diff() / max(fx.diff().std(), 1e-6)}).fillna(0.0)


# ─────────────────────────── model ───────────────────────────

def make_model(lr=1e-3):
    import tensorflow as tf
    from keras.layers import Dense, Dropout, Input, LSTM
    from keras.models import Sequential
    m = Sequential([Input(shape=(SEQ_LEN, len(FEATS))), LSTM(64, return_sequences=True), Dropout(0.2), LSTM(32),
                    Dropout(0.2), Dense(16, activation="relu"), Dense(HORIZON)])
    m.compile(optimizer=tf.keras.optimizers.Adam(lr), loss="mse")
    return m


def fit(m, X, y, Xv, yv, patience=10):
    from keras.callbacks import EarlyStopping
    h = m.fit(X, y, validation_data=(Xv, yv), epochs=T.EPOCHS, batch_size=64, verbose=0,
              callbacks=[EarlyStopping(monitor="val_loss", patience=patience, min_delta=0.0, restore_best_weights=True)])
    return len(h.history["loss"])


# ─────────────────────────── run ───────────────────────────

def run(seed=42, report=True):
    T._seed_everything(seed)
    df = load_merged_frame()
    drv = drivers_frame(df)
    panel = build_panel()

    # rice split rows (identical to production / lstm_improve)
    rice = {}
    for t in RICE_COLUMNS:
        sub, _ = build_feature_frame(df, t)
        n_seq = len(sub) - SEQ_LEN - HORIZON + 1
        i_tr, i_va, _ = T._split_indices(sub, n_seq, t)
        s0 = i_tr + int(round(0.6 * (i_va - i_tr)))
        dates = pd.to_datetime(sub["Date"]).reset_index(drop=True)
        rice[t] = {"sub": sub, "dates": dates, "i_tr": i_tr, "i_va": i_va, "s0": s0, "n_seq": n_seq,
                   "s": pd.Series(pd.to_numeric(sub[t]).values, index=dates)}
    sel_start = min(rice[t]["dates"][rice[t]["s0"] + SEQ_LEN - 1] for t in RICE_COLUMNS)
    pre_end = sel_start - pd.Timedelta(days=1)

    # ── pre-training panel: non-rice commodities observed on most days of the pre-training window
    pre = panel[(panel.index >= PRE_START) & (panel.index <= pre_end)]
    keep = [c for c in pre.columns if "rice" not in c and pre[c].notna().mean() >= 0.7 and pre[c].diff().abs().gt(1e-6).sum() >= 20]
    full_idx = pd.date_range(PRE_START, pre_end, freq="D")
    Xs, Ys = [], []
    for c in keep:
        s = pre[c].reindex(full_idx).ffill(limit=2)
        sd = float(s.diff().std())
        if not np.isfinite(sd) or sd <= 0:
            continue
        X, Y, _ = windows(features(s, drv, sd), s, sd, full_idx[0], full_idx[-1])
        if len(X):
            Xs.append(X); Ys.append(Y)
    Xp, Yp = np.concatenate(Xs), np.concatenate(Ys)
    perm = np.random.default_rng(seed).permutation(len(Xp))
    cut = int(0.85 * len(Xp))
    tr, va = perm[:cut], perm[cut:]
    base = make_model()
    ep = fit(base, Xp[tr], Yp[tr], Xp[va], Yp[va])
    if report:
        print(f"pre-trained on {len(keep)} commodities, {len(Xp)} sequences, {ep} epochs (window {PRE_START}..{pre_end.date()})", flush=True)
    base_w = base.get_weights()

    results = {}
    for variant in ("zero_shot", "fine_tuned"):
        preds = {}
        for t in RICE_COLUMNS:
            r = rice[t]
            s = r["s"]
            daily = s[s.index >= PRE_START]
            sd = float(daily[daily.index <= pre_end].diff().std())
            f = features(s, drv, sd)
            m = make_model(lr=1e-4)
            m.set_weights(base_w)
            if variant == "fine_tuned":
                Xf, Yf, _ = windows(f, s, sd, pd.Timestamp(PRE_START), pre_end)
                sel_a, sel_b = r["dates"][r["s0"] + SEQ_LEN - 1], r["dates"][r["i_va"] + SEQ_LEN - 1]
                Xv, Yv, _ = windows(f, s, sd, sel_a, sel_b)
                fit(m, Xf, Yf, Xv, Yv, patience=8)
            # delta forecasts (pesos) for every anchor row of the selection and test windows
            anchors = np.arange(r["s0"], r["n_seq"]) + SEQ_LEN - 1
            X = np.stack([f.values[a - SEQ_LEN + 1:a + 1] for a in anchors])
            preds[t] = (anchors, np.asarray(m.predict(X, verbose=0)) * sd)
        results[variant] = evaluate(rice, preds)
        if report:
            b = results[variant]
            print(f"  {variant}: best on selection {b['best']}  sel {b['configs'][b['best']]['sel']}  TEST {b['configs'][b['best']]['test']}"
                  f" | reversion-only TEST {b['configs']['w0.0_rev']['test']} | ablation {b['ablation']}", flush=True)
    return results


def evaluate(rice, preds):
    cfgs = {}
    parts_cache = {}
    for t, r in rice.items():
        s = r["s"].values
        dows = r["dates"].dt.dayofweek.values
        anchors, delta = preds[t]
        for part, (a, z) in {"sel": (r["s0"], r["i_va"]), "test": (r["i_va"], r["n_seq"])}.items():
            rows = np.arange(a, z) + SEQ_LEN - 1
            k = rows - anchors[0]
            corr = np.array([rolling_phi(s, x, HORIZON, dows=dows)[0][:, 0] * (s[x] - s[x - 1]) for x in rows])
            true = np.stack([s[x + 1:x + 1 + HORIZON] for x in rows])
            parts_cache[(t, part)] = (rows, delta[k], corr, true, s[rows])
    for use_rev in (True, False):
        for w in (0.0, 0.25, 0.5, 1.0):
            if w == 0.0 and not use_rev:
                continue
            key = f"w{w}_{'rev' if use_rev else 'norev'}"
            cfgs[key] = {"sel": [], "test": []}
            for t in rice:
                for part in ("sel", "test"):
                    rows, d, corr, true, anc = parts_cache[(t, part)]
                    pred = anc[:, None] + w * d + (corr if use_rev else 0)
                    mae, base = np.abs(true - pred).mean(), np.abs(true - anc[:, None]).mean()
                    cfgs[key][part].append((base - mae) / base * 100)
    summary = {k: {"sel": round(float(np.mean(v["sel"])), 2), "test": round(float(np.mean(v["test"])), 2),
                   "test_min": round(float(np.min(v["test"])), 2)} for k, v in cfgs.items()}
    best = max((k for k in summary if not k.startswith("w0.0")), key=lambda k: summary[k]["sel"])
    w = float(best.split("_")[0][1:]); use_rev = best.endswith("_rev")
    F, R, Y, A, D = [], [], [], [], []
    for t in rice:
        rows, d, corr, true, anc = parts_cache[(t, "test")]
        s = rice[t]["s"].values
        F.append(anc[:, None] + w * d + (corr if use_rev else 0)); R.append(anc[:, None] + corr)
        Y.append(true); A.append(anc); D.append(np.array([s[x] - s[x - 1] for x in rows]))
    F, R, Y, A, D = map(np.concatenate, (F, R, Y, A, D))
    return {"configs": summary, "best": best,
            "ablation": {"mcnemar": mcnemar(F, R, Y, A, D), "paired_error": sign_test(F, R, Y)}}


if __name__ == "__main__":
    res = {"seed_42": run(42)}
    json.dump(res, open(OUT, "w"), indent=1)
    # stability of whichever variant won on selection
    winner = max(res["seed_42"], key=lambda v: res["seed_42"][v]["configs"][res["seed_42"][v]["best"]]["sel"])
    best_key = res["seed_42"][winner]["best"]
    print(f"\nwinner on selection: {winner} {best_key}; stability check with 3 more seeds:")
    for seed in (7, 123, 2024):
        r = run(seed, report=False)
        res[f"seed_{seed}"] = r
        c = r[winner]["configs"]
        print(f"  seed {seed}: {winner} {best_key} TEST {c[best_key]['test']}  (reversion-only {c['w0.0_rev']['test']})", flush=True)
        json.dump(res, open(OUT, "w"), indent=1)

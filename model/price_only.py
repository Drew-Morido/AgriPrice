"""
AgriPricePH — the "without factors" models for Admin -> Forecast vs Actual (Ma'am Shein's request, 2026-10-26).

Eight LSTM models, one per rice type, trained with exactly the production recipe (train.py: same split, scaler fit
on training rows only, anchored-delta targets, architecture, epochs and early stopping) but with the rice price as
the ONLY input: no diesel, exchange rate, rice stocks, farmgate price, core inflation, world rice price or season.
Everything after the network is identical to the published forecast (weekday mean-reversion term, ARIMA, Kalman
filter, adaptive weights), so the "with factors" and "without factors" forecasts differ only in what the LSTM sees.

    cd model && py -3.13 price_only.py        # trains all 8 (a few minutes on CPU), writes lstm_models_price_only/

Production files are never touched.
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime

import numpy as np
from sklearn.preprocessing import MinMaxScaler

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

from data_pipeline import HORIZON, RICE_COLUMNS, SEQ_LEN, build_feature_frame, load_merged_frame, make_sequences  # noqa: E402

OUT_DIR = os.path.join(HERE, "lstm_models_price_only")
META_PATH = os.path.join(OUT_DIR, "meta.json")


def paths(target: str) -> tuple[str, str]:
    return os.path.join(OUT_DIR, f"{target}.keras"), os.path.join(OUT_DIR, f"{target}_scaler.joblib")


def price_frame(df, target):
    """The production row set for this rice type (build_feature_frame), with the price as the only column."""
    sub, _features = build_feature_frame(df, target)
    return sub, [target]


def train_one(df, target: str) -> dict | None:
    import train as T

    T._seed_everything(T.SEED)
    sub, features = price_frame(df, target)
    raw = sub[features].values.astype(float)
    n_seq = len(raw) - SEQ_LEN - HORIZON + 1
    i_tr, i_va, policy = T._split_indices(sub, n_seq, target)
    scaler = MinMaxScaler().fit(raw[: i_tr + SEQ_LEN])
    X, y_level = make_sequences(scaler.transform(raw), 0, SEQ_LEN, HORIZON)
    anchors = X[:, -1, 0]
    y = y_level - anchors[:, None]
    model_path, scaler_path = paths(target)
    t0 = time.time()
    T._train_tensorflow(X[:i_tr], y[:i_tr], X[i_tr:i_va], y[i_tr:i_va], X[i_va:], y[i_va:], scaler, 0, 1,
                        model_path, scaler_path, target_name=f"{target} (price only)")
    return {"train_rows": int(i_tr), "val_rows": int(i_va - i_tr), "split": policy, "seconds": round(time.time() - t0, 1)}


def train_all() -> dict:
    os.makedirs(OUT_DIR, exist_ok=True)
    df = load_merged_frame()
    out = {"trained_at": datetime.now().isoformat(timespec="seconds"), "inputs": "rice price only",
           "data_last_date": str(df["Date"].iloc[-1])[:10], "targets": {}}
    for t in RICE_COLUMNS:
        info = train_one(df, t)
        if info:
            out["targets"][t] = info
            print(f"[price-only] {t}: {info}", flush=True)
    with open(META_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    return out


def available() -> bool:
    return all(os.path.exists(paths(t)[0]) and os.path.exists(paths(t)[1]) for t in RICE_COLUMNS)


if __name__ == "__main__":
    train_all()

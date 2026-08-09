# model/predict.py — 2-day LSTM inference for all rice types (cached models)
import json
import os
import threading
import time
from datetime import date

import joblib
import numpy as np
import pandas as pd

from data_pipeline import (
    HORIZON,
    RICE_COLUMNS,
    SEQ_LEN,
    TARGET_COLUMN,
    build_feature_frame,
    load_merged_frame,
)

MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
LSTM_MODELS_DIR = os.path.join(MODEL_DIR, "lstm_models")
MODEL_PATH = os.path.join(MODEL_DIR, "lstm_model.keras")
MLP_PATH = os.path.join(MODEL_DIR, "rice_mlp.joblib")
SCALER_PATH = os.path.join(MODEL_DIR, "scaler.joblib")
META_PATH = os.path.join(MODEL_DIR, "meta.json")

RICE_PRICE_COLUMNS = list(RICE_COLUMNS)

# In-memory caches — avoid reloading 8 Keras models on every HTTP request
_CACHE_LOCK = threading.Lock()
_KERAS_CACHE: dict[str, object] = {}
_MLP_CACHE: dict[str, object] = {}
_SCALER_CACHE: dict[str, object] = {}
_META_CACHE: dict | None = None
_DF_CACHE: dict = {"ts": 0.0, "df": None}
_DF_CACHE_SEC = 90


def _inverse_target(scaled_vals, scaler, target_idx):
    scale = scaler.scale_[target_idx]
    min_ = scaler.min_[target_idx]
    return (np.asarray(scaled_vals) - min_) / scale


def _confidence_ratio(mae_peso: float, mean_price: float, cap_high: float = 0.99, cap_low: float = 0.55) -> float:
    if mean_price <= 0 or mae_peso < 0:
        return 0.7
    pct = max(0.0, min(99.9, 100.0 - (mae_peso / mean_price * 100.0)))
    return max(cap_low, min(cap_high, pct / 100.0))


def _holdout_accuracy_confidence(tmeta: dict, meta: dict | None = None) -> float:
    """
    Match dashboard / Training History: use hold-out test accuracy_pct when saved.
  Falls back to MAE-derived ratio only if accuracy is missing.
    """
    meta = meta or {}
    acc = tmeta.get("accuracy_pct")
    if acc is None:
        acc = meta.get("accuracy_pct")
    if acc is not None:
        return max(0.65, min(0.99, float(acc) / 100.0))
    mae = tmeta.get("mae_peso") or meta.get("mae_peso")
    if mae is not None:
        mean_hint = float(tmeta.get("mean_price") or meta.get("mean_price") or 50.0)
        return _confidence_ratio(float(mae), mean_hint)
    return 0.75


def _targets_meta(meta: dict) -> dict:
    if isinstance(meta.get("targets"), dict) and meta["targets"]:
        return meta["targets"]
    if meta.get("target"):
        return {meta["target"]: meta}
    return {TARGET_COLUMN: meta}


def _load_meta() -> dict:
    global _META_CACHE
    if _META_CACHE is not None:
        return _META_CACHE
    meta = {}
    if os.path.exists(META_PATH):
        with open(META_PATH, encoding="utf-8") as f:
            meta = json.load(f)
    _META_CACHE = meta
    return meta


def _get_merged_frame() -> pd.DataFrame:
    now = time.time()
    if _DF_CACHE["df"] is not None and (now - _DF_CACHE["ts"]) < _DF_CACHE_SEC:
        return _DF_CACHE["df"].copy()
    df = load_merged_frame()
    _DF_CACHE["df"] = df
    _DF_CACHE["ts"] = now
    return df.copy()


def invalidate_caches() -> None:
    """Call after training completes so new weights are loaded."""
    global _META_CACHE
    with _CACHE_LOCK:
        _KERAS_CACHE.clear()
        _MLP_CACHE.clear()
        _SCALER_CACHE.clear()
        _META_CACHE = None
        _DF_CACHE["df"] = None
        _DF_CACHE["ts"] = 0.0


def _model_paths(target: str) -> tuple[str, str, str]:
    return (
        os.path.join(LSTM_MODELS_DIR, f"{target}.keras"),
        os.path.join(LSTM_MODELS_DIR, f"{target}_scaler.joblib"),
        os.path.join(LSTM_MODELS_DIR, f"{target}_mlp.joblib"),
    )


def _legacy_paths(target: str) -> tuple[str | None, str | None]:
    if target != TARGET_COLUMN:
        return None, None
    if os.path.exists(MODEL_PATH) and os.path.exists(SCALER_PATH):
        return MODEL_PATH, SCALER_PATH
    if os.path.exists(MLP_PATH) and os.path.exists(SCALER_PATH):
        return MLP_PATH, SCALER_PATH
    return None, None


def _resolve_paths(target: str) -> tuple[str | None, str | None, str | None]:
    keras_path, scaler_path, mlp_path = _model_paths(target)
    legacy_model, legacy_scaler = _legacy_paths(target)
    if not os.path.exists(scaler_path) and legacy_scaler:
        scaler_path = legacy_scaler
    if legacy_model and not os.path.exists(keras_path or "") and not os.path.exists(mlp_path or ""):
        if legacy_model.endswith(".keras"):
            keras_path = legacy_model
        else:
            mlp_path = legacy_model
    if not scaler_path or not os.path.exists(scaler_path):
        return None, None, None
    if keras_path and not os.path.exists(keras_path):
        keras_path = None
    if mlp_path and not os.path.exists(mlp_path):
        mlp_path = None
    if not keras_path and not mlp_path:
        return None, None, None
    return keras_path, scaler_path, mlp_path


def _get_scaler(path: str):
    with _CACHE_LOCK:
        if path not in _SCALER_CACHE:
            _SCALER_CACHE[path] = joblib.load(path)
        return _SCALER_CACHE[path]


def _get_keras(path: str):
    with _CACHE_LOCK:
        if path not in _KERAS_CACHE:
            import tensorflow as tf

            os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
            _KERAS_CACHE[path] = tf.keras.models.load_model(path)
        return _KERAS_CACHE[path]


def _get_mlp(path: str):
    with _CACHE_LOCK:
        if path not in _MLP_CACHE:
            _MLP_CACHE[path] = joblib.load(path)
        return _MLP_CACHE[path]


def warm_cache(targets: list[str] | None = None) -> int:
    """Pre-load LSTM artifacts (call once at API startup). Returns count loaded."""
    loaded = 0
    meta = _load_meta()
    per_target = _targets_meta(meta)
    cols = targets or list(per_target.keys()) or RICE_PRICE_COLUMNS
    for target in cols:
        keras_path, scaler_path, mlp_path = _resolve_paths(target)
        if not scaler_path:
            continue
        _get_scaler(scaler_path)
        if keras_path:
            _get_keras(keras_path)
            loaded += 1
        elif mlp_path:
            _get_mlp(mlp_path)
            loaded += 1
    return loaded


def _run_lstm_inference(
    df: pd.DataFrame,
    target: str,
    target_meta: dict,
    anchor: pd.Timestamp,
    meta: dict | None = None,
) -> list | None:
    meta = meta or _load_meta()
    keras_path, scaler_path, mlp_path = _resolve_paths(target)
    if not scaler_path:
        return None

    # Rebuild the exact engineered feature set used at training time (seasonality/lag/rolling).
    sub, features = build_feature_frame(df, target)
    if len(sub) < SEQ_LEN:
        return None

    scaler = _get_scaler(scaler_path)
    # Guard against a stale model whose feature count no longer matches the pipeline.
    expected = getattr(scaler, "n_features_in_", len(features))
    if expected != len(features):
        return None

    target_idx = features.index(target)
    scaled = scaler.transform(sub[features].values.astype(float))
    window = scaled[-SEQ_LEN:].reshape(1, SEQ_LEN, len(features))

    if keras_path:
        model = _get_keras(keras_path)
        pred_scaled = model.predict(window, verbose=0)[0]
    elif mlp_path:
        mlp = _get_mlp(mlp_path)
        pred_scaled = mlp.predict(window.reshape(1, -1))[0]
    else:
        return None

    # In delta mode the model predicts change-from-anchor; add the last scaled value back.
    delta_mode = bool(target_meta.get("delta_mode", (meta or {}).get("delta_mode", False)))
    if delta_mode:
        anchor_scaled = float(window[0, -1, target_idx])
        pred_scaled = anchor_scaled + np.asarray(pred_scaled)

    prices = _inverse_target(pred_scaled, scaler, target_idx)
    last_price = float(sub[target].iloc[-1])
    if last_price <= 0:
        return None

    mean_price = float(pd.to_numeric(sub[target], errors="coerce").mean() or last_price)
    tmeta = dict(target_meta)
    tmeta.setdefault("mean_price", mean_price)
    conf = _holdout_accuracy_confidence(tmeta, meta)

    days: list = []
    prev = last_price
    for i, price in enumerate(prices[:HORIZON]):
        d = anchor + pd.Timedelta(days=i + 1)
        change = float(price - prev)
        days.append({
            "day": i + 1,
            "date": d.strftime("%b %d"),
            "date_iso": d.strftime("%Y-%m-%d"),
            "price": round(float(price), 2),
            "change": round(change, 2),
            "confidence": round(float(conf), 3),
            "model": "lstm",
        })
        prev = float(price)
    return days


def _trend_forecast_days(
    series: np.ndarray,
    last_price: float,
    anchor: pd.Timestamp,
    tmeta: dict | None = None,
    meta: dict | None = None,
) -> list:
    tail = series[~np.isnan(series)]
    tail = tail[tail > 0][-14:]
    slope = 0.0
    if len(tail) >= 2:
        n = len(tail)
        x = np.arange(n, dtype=float)
        sum_x = x.sum()
        sum_y = tail.sum()
        sum_xy = (x * tail).sum()
        sum_xx = (x * x).sum()
        denom = n * sum_xx - sum_x * sum_x
        slope = (n * sum_xy - sum_x * sum_y) / denom if denom else 0.0
    base = float(tail[-1]) if len(tail) else last_price
    tm = dict(tmeta or {})
    tm.setdefault("mean_price", float(np.nanmean(tail)) if len(tail) else last_price)
    conf = _holdout_accuracy_confidence(tm, meta)
    days: list = []
    prev = last_price if last_price > 0 else base
    for i in range(HORIZON):
        price = max(0.01, base + slope * (i + 1))
        d = anchor + pd.Timedelta(days=i + 1)
        days.append({
            "day": i + 1,
            "date": d.strftime("%b %d"),
            "date_iso": d.strftime("%Y-%m-%d"),
            "price": round(float(price), 2),
            "change": round(float(price - prev), 2),
            "confidence": round(float(conf), 3),
            "model": "trend",
        })
        prev = price
    return days


def _formula_forecast_days_2026(
    df: pd.DataFrame,
    target: str,
    anchor: pd.Timestamp,
    tmeta: dict | None = None,
    meta: dict | None = None,
) -> list | None:
    if target not in df.columns:
        return None
    target_series = pd.to_numeric(df[target], errors="coerce").dropna()
    if target_series.empty:
        return None
    last_price = float(target_series.iloc[-1])
    if last_price <= 0:
        return None

    def pct_trend(col: str, lookback: int = 7) -> float:
        if col not in df.columns:
            return 0.0
        s = pd.to_numeric(df[col], errors="coerce").dropna()
        if len(s) < 2:
            return 0.0
        tail = s.iloc[-min(lookback, len(s)) :]
        base = float(tail.iloc[0])
        last = float(tail.iloc[-1])
        if abs(base) < 1e-9:
            return 0.0
        return (last - base) / abs(base)

    rice_pct = pct_trend(target, 7)
    fuel_col = "fuel_diesel" if "fuel_diesel" in df.columns else "fuel"
    fuel_pct = pct_trend(fuel_col, 7)
    fx_pct = pct_trend("exchange", 7)

    # 2026 formula mode: use prevailing rice trend + fuel and currency pressure.
    weighted_daily_pct = (0.70 * rice_pct + 0.20 * fuel_pct + 0.10 * fx_pct) / 7.0
    weighted_daily_pct = float(np.clip(weighted_daily_pct, -0.03, 0.03))

    tm = dict(tmeta or {})
    tm.setdefault("mean_price", float(target_series.mean()))
    conf = _holdout_accuracy_confidence(tm, meta)

    out: list = []
    prev = last_price
    for i in range(HORIZON):
        price = max(0.01, prev * (1.0 + weighted_daily_pct))
        d = anchor + pd.Timedelta(days=i + 1)
        out.append({
            "day": i + 1,
            "date": d.strftime("%b %d"),
            "date_iso": d.strftime("%Y-%m-%d"),
            "price": round(float(price), 2),
            "change": round(float(price - prev), 2),
            "confidence": round(float(conf), 3),
            "model": "formula_2026",
        })
        prev = float(price)
    return out


def formula_mode_enabled() -> bool:
    """
    The multivariate LSTM is the primary forecaster. The heuristic 2026 formula is
    an explicit opt-in fallback (OFF by default) for demos/debugging only — enable
    with AGRIPRICE_FORMULA_MODE=1. It is no longer tied to the calendar year, so
    live forecasts are produced by the trained LSTM models.
    """
    return os.environ.get("AGRIPRICE_FORMULA_MODE", "0").strip().lower() in ("1", "true", "yes")


def _build_forecasts_by_key(df: pd.DataFrame, meta: dict) -> dict:
    anchor = pd.Timestamp(date.today())
    per_target_meta = _targets_meta(meta)
    out: dict = {}
    use_formula_mode = formula_mode_enabled()

    for col in RICE_PRICE_COLUMNS:
        if col not in df.columns:
            continue
        series = pd.to_numeric(df[col], errors="coerce").values
        if not np.any(series > 0):
            continue
        last = float(series[~np.isnan(series)][-1])
        tmeta = per_target_meta.get(col, meta if col == TARGET_COLUMN else {})
        # LSTM first; heuristic formula only when explicitly enabled; trend as last resort.
        days = _formula_forecast_days_2026(df, col, anchor, tmeta, meta) if use_formula_mode else None
        if not days:
            days = _run_lstm_inference(df, col, tmeta, anchor, meta)
        if not days:
            days = _trend_forecast_days(series, last, anchor, tmeta, meta)
        if days:
            out[col] = days

    return out


def predict():
    meta = _load_meta()

    has_any = (
        os.path.exists(SCALER_PATH)
        or os.path.exists(MODEL_PATH)
        or os.path.exists(MLP_PATH)
        or (
            os.path.isdir(LSTM_MODELS_DIR)
            and any(f.endswith((".keras", "_mlp.joblib")) for f in os.listdir(LSTM_MODELS_DIR))
        )
    )
    if not has_any:
        return {"error": "Model not trained yet. Run Training module first.", "ready": False}

    df = _get_merged_frame()
    forecasts_by_key = _build_forecasts_by_key(df, meta)

    if not forecasts_by_key:
        return {"error": "No rice price data available for forecasting.", "ready": False}

    primary_days = forecasts_by_key.get(TARGET_COLUMN) or next(iter(forecasts_by_key.values()))
    per_target_meta = _targets_meta(meta)
    primary_meta = per_target_meta.get(TARGET_COLUMN, meta)

    last_price = float(df[TARGET_COLUMN].iloc[-1]) if TARGET_COLUMN in df.columns else 0.0
    last_data_date = pd.to_datetime(df["Date"].iloc[-1])
    today = pd.Timestamp(date.today())
    # Report the method that actually produced the primary forecast, not a calendar guess.
    primary_model = (primary_days[0].get("model") if primary_days else None) or "lstm"

    hist_tail = 30
    labels = [d.strftime("%m/%d/%Y") for d in df["Date"].iloc[-hist_tail:]]
    history = [round(float(v), 2) for v in df[TARGET_COLUMN].iloc[-hist_tail:]]

    all_rice = {}
    for col in RICE_PRICE_COLUMNS:
        if col not in df.columns:
            continue
        val = pd.to_numeric(df[col].iloc[-1], errors="coerce")
        if pd.isna(val) or float(val) <= 0:
            continue
        all_rice[col] = round(float(val), 2)

    accuracies = [
        float(m["accuracy_pct"])
        for m in per_target_meta.values()
        if m.get("accuracy_pct") is not None
    ]
    avg_accuracy = round(sum(accuracies) / len(accuracies), 2) if accuracies else None
    backend = primary_meta.get("backend") or meta.get("backend", "tensorflow")

    return {
        "ready": True,
        "backend": backend,
        "rice_type": "All rice types (LSTM)",
        "target": TARGET_COLUMN,
        "horizon": HORIZON,
        "last_price": round(last_price, 2),
        "last_data_date": last_data_date.strftime("%Y-%m-%d"),
        "as_of_date": today.strftime("%Y-%m-%d"),
        "as_of_display": today.strftime("%B %d, %Y"),
        "last_date": today.strftime("%Y-%m-%d"),
        "forecast": primary_days,
        "forecasts_by_key": forecasts_by_key,
        "current_prices": all_rice,
        "metrics": {
            "mae_peso": primary_meta.get("mae_peso") or meta.get("mae_peso"),
            "rmse_peso": primary_meta.get("rmse_peso") or meta.get("rmse_peso"),
            "accuracy_pct": primary_meta.get("accuracy_pct") or meta.get("accuracy_pct"),
            "avg_accuracy_pct": avg_accuracy,
            "by_target": {
                k: {"mae_peso": v.get("mae_peso"), "accuracy_pct": v.get("accuracy_pct")}
                for k, v in per_target_meta.items()
            },
        },
        "model_notes": {
            "method": {
                "lstm": "Per-type LSTM (one model per rice column)",
                "formula_2026": "2026 formula mode (rice+fuel+currency)",
                "trend": "Linear trend fallback (no model available)",
            }.get(primary_model, "Per-type LSTM (one model per rice column)"),
            "primary_model": primary_model,
            "trained_types": meta.get("trained_types") or list(forecasts_by_key.keys()),
            "lstm_count": len(forecasts_by_key),
            "avg_accuracy_pct": avg_accuracy,
            "formula_mode": formula_mode_enabled(),
        },
        "history": {"labels": labels, "values": history},
    }


if __name__ == "__main__":
    import pprint
    pprint.pprint(predict())

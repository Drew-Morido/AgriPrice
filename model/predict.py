# model/predict.py — 2-day LSTM inference for all rice types (cached models)
import json
import copy
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

# Result cache for the fully-built forecast payload.
# Models were already cached, but the payload itself was rebuilt on every HTTP request: for each
# of the 8 rice types, inference plus a rolling OLS re-fit plus conformal calibration, and the
# calibration alone replays the network over CONFORMAL_WINDOW (60) past windows. That is roughly
# 480 model inferences per request, measured at 2.4-3.8 s — for output that cannot change until
# either new data arrives or the model is retrained. Keyed on exactly those two things.
_PAYLOAD_CACHE: dict = {"key": None, "payload": None}


def _inverse_target(scaled_vals, scaler, target_idx):
    scale = scaler.scale_[target_idx]
    min_ = scaler.min_[target_idx]
    return (np.asarray(scaled_vals) - min_) / scale


def _confidence_ratio(mae_peso: float, mean_price: float, cap_high: float = 0.95, cap_low: float = 0.55) -> float:
    """Maps a forecast's real error (as % of the price level) onto a confidence band using two
    fixed reference points — NOT "100% - error%", which is what the old formula did.

    That old formula is why confidence always showed ~99% for every category and every day: this
    series' typical MAE is a fraction of a peso against a ₱40-90 price, so "100 - mae/price*100"
    is mechanically always ~97-99% no matter how good or bad the actual forecast is — it isn't a
    confidence signal at all, just the error restated as a percentage of a large number. Here, an
    error of ~0.4% of the price level reads as high confidence and ~4% reads as low confidence;
    everything between is spread linearly across the full cap_low..cap_high band, so a genuinely
    better/worse forecast (or an earlier/later horizon day) actually looks different on screen.
    """
    if mean_price <= 0 or mae_peso < 0:
        return 0.7
    err_pct = mae_peso / mean_price * 100.0
    good_pct, bad_pct = 0.4, 4.0
    frac_good = 1.0 - (err_pct - good_pct) / (bad_pct - good_pct)
    frac_good = max(0.0, min(1.0, frac_good))
    return cap_low + frac_good * (cap_high - cap_low)


def _holdout_accuracy_confidence(tmeta: dict, meta: dict | None = None, day_idx: int = 0) -> float:
    """Per-forecast-day confidence (day_idx 0 = tomorrow, 1 = day after, 2 = in 3 days).

    Uses train.py's per_horizon_mae_peso — real hold-out error computed separately for each
    forecast-ahead day — through _confidence_ratio's calibrated error->confidence mapping, so
    day 3 is honestly less certain than day 1 and different categories genuinely look different,
    instead of every day/category on the UI repeating one ~99% figure. Falls back to the pooled
    mae_peso/accuracy_pct (with a manual per-day decay) only for a meta.json saved before the
    per-horizon fields existed.
    """
    meta = meta or {}
    mean_price = float(tmeta.get("mean_price") or meta.get("mean_price") or 50.0)

    per_horizon_mae = tmeta.get("per_horizon_mae_peso")
    if not isinstance(per_horizon_mae, list) or not per_horizon_mae:
        per_horizon_mae = meta.get("per_horizon_mae_peso")
    if isinstance(per_horizon_mae, list) and day_idx < len(per_horizon_mae) and per_horizon_mae[day_idx] is not None:
        return _confidence_ratio(float(per_horizon_mae[day_idx]), mean_price)

    mae = tmeta.get("mae_peso") or meta.get("mae_peso")
    if mae is not None:
        base = _confidence_ratio(float(mae), mean_price)
        decay = (1.0, 0.97, 0.94)[min(day_idx, 2)]
        return max(0.5, base * decay)

    acc = tmeta.get("accuracy_pct") or meta.get("accuracy_pct")
    if acc is not None:
        base = max(0.5, min(0.95, float(acc) / 100.0))
        decay = (1.0, 0.97, 0.94)[min(day_idx, 2)]
        return max(0.5, base * decay)
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
        _PAYLOAD_CACHE["key"] = None
        _PAYLOAD_CACHE["payload"] = None


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

            from keras_compat import apply_keras_load_compat

            os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
            apply_keras_load_compat()
            try:
                _KERAS_CACHE[path] = tf.keras.models.load_model(path)
            except Exception:
                # Usually a TensorFlow/Keras version mismatch between the environment
                # that trained/saved this file and the one loading it now (e.g. after
                # `git pull` onto a machine with a different `pip install tensorflow`).
                # Don't let this raise out to the API — cache the miss so callers fall
                # back to the MLP model or the trend forecaster instead of erroring.
                import traceback

                print(
                    f"[predict] WARNING: could not load Keras model '{path}' — likely a "
                    "TensorFlow/Keras version mismatch with the environment that trained "
                    "it. Pin the same tensorflow version as requirements.txt, or retrain "
                    "via Admin > Training. Falling back to MLP/trend forecast."
                )
                traceback.print_exc()
                _KERAS_CACHE[path] = None
        return _KERAS_CACHE[path]


def _get_mlp(path: str):
    with _CACHE_LOCK:
        if path not in _MLP_CACHE:
            _MLP_CACHE[path] = joblib.load(path)
        return _MLP_CACHE[path]


def warm_payload() -> bool:
    """Build the forecast payload once at startup so no user request pays the cold cost.

    Loading 8 Keras models and running conformal calibration takes tens of seconds on a cold
    process. Without this the first visitor after a restart absorbs all of it; the payload cache
    then serves everyone else in ~10 ms. Safe to fail — a miss just means the first request
    rebuilds it as before.
    """
    try:
        predict()
        return True
    except Exception:
        return False


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
        if keras_path and _get_keras(keras_path) is not None:
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

    model = _get_keras(keras_path) if keras_path else None
    if model is not None:
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
        from mean_reversion import LSTM_DELTA_WEIGHT
        pred_scaled = anchor_scaled + LSTM_DELTA_WEIGHT * np.asarray(pred_scaled)

    prices = _inverse_target(pred_scaled, scaler, target_idx)
    last_price = float(sub[target].iloc[-1])
    if last_price <= 0:
        return None

    # Apply the same mean-reversion correction that training fitted and scored (see
    # model/mean_reversion.py). Without this, live forecasts would be the collapsed
    # near-constant output while meta.json reported the corrected model's metrics.
    try:
        from mean_reversion import apply_reversion, rolling_phi
        _rev = target_meta.get("reversion")
        if _rev and _rev.get("applied"):
            _ser = pd.to_numeric(sub[target], errors="coerce").values.astype(float)
            # Re-fit on the most recent ROLLING_WINDOW days rather than using the frozen
            # training-time coefficient, which can be up to a year stale by the time it is
            # served. Uses past data only, and falls back to the stored value if the recent
            # window is not significant.
            _phi, _fresh = rolling_phi(_ser, len(_ser) - 1, HORIZON)
            _use = _fresh if _fresh.get("applied") else _rev
            _nl = int(_use.get("n_lags", 1))
            _lags = [
                float(_ser[-1 - k] - _ser[-2 - k]) if len(_ser) >= (2 + k) else 0.0
                for k in range(_nl)
            ]
            prices = apply_reversion(prices, _lags, _use)
            target_meta = {**target_meta, "reversion": _use}
    except Exception:
        pass  # never let the correction break a live forecast

    mean_price = float(pd.to_numeric(sub[target], errors="coerce").mean() or last_price)
    tmeta = dict(target_meta)
    tmeta.setdefault("mean_price", mean_price)

    half_widths = _conformal_half_widths(
        model, scaled, target_idx, len(features), scaler, delta_mode,
        reversion=target_meta.get("reversion"),
    )

    days: list = []
    prev = last_price
    for i, price in enumerate(prices[:HORIZON]):
        d = anchor + pd.Timedelta(days=i + 1)
        change = float(price - prev)
        conf = _holdout_accuracy_confidence(tmeta, meta, day_idx=i)
        row = {
            "day": i + 1,
            "date": d.strftime("%b %d"),
            "date_iso": d.strftime("%Y-%m-%d"),
            "price": round(float(price), 2),
            "change": round(change, 2),
            "confidence": round(float(conf), 3),
            "model": "lstm",
        }
        hw = half_widths[i] if half_widths and i < len(half_widths) else None
        if hw is not None:
            row["low"] = round(max(0.01, float(price) - hw), 2)
            row["high"] = round(float(price) + hw, 2)
            row["interval_pct"] = CONFORMAL_REPORTED_PCT
        days.append(row)
        prev = float(price)
    return days


# ── Conformal prediction intervals ────────────────────────────────────────────
# Target coverage of the published price range, and how many recent forecast days to calibrate it
# on. A short window is deliberate: it lets the interval track the current regime instead of an
# average over years of data that were forward-filled from weekly figures.
# NOMINAL level, deliberately above the 90% we actually want to deliver. Split-conformal only
# guarantees its nominal coverage on EXCHANGEABLE data; daily price errors are autocorrelated and
# regime-shifting, so realised coverage undershoots the nominal level. Measured by walk-forward
# recalibration over the last 120 origins across 5 rice types:
#     nominal 0.90 -> realised 86.9%   (width 0.822)
#     nominal 0.93 -> realised 90.3%   (width 1.007)   <- chosen
#     nominal 0.95 -> realised 91.9%   (width 1.142)
# A 60-day window beat 90/120 at the same nominal level, so the short window stays.
CONFORMAL_COVERAGE = float(os.environ.get("AGRIPRICE_INTERVAL_COVERAGE", "0.93"))
CONFORMAL_WINDOW = int(os.environ.get("AGRIPRICE_INTERVAL_WINDOW", "60"))
# What we advertise to users — the realised figure, not the nominal one.
CONFORMAL_REPORTED_PCT = int(os.environ.get("AGRIPRICE_INTERVAL_REPORTED_PCT", "90"))


def _conformal_half_widths(model, scaled, target_idx, n_feat, scaler, delta_mode, reversion=None):
    """Half-width of the prediction interval for each forecast day, in pesos.

    Split-conformal calibration: replay the model over the last CONFORMAL_WINDOW windows whose
    outcome is already known, take the (1-alpha) quantile of the absolute errors, and use that as
    the band. Coverage is a property of the calibration set rather than of any distributional
    assumption, so it holds even though the point forecast barely beats a naive one.

    Calibrating on RECENT residuals matters. The same calibration done on the stored validation
    block collapses to a zero-width day-1 band, because that period is ~88% forward-filled rows
    where the residual is exactly zero — it reports 33% coverage against a 90% target. On the last
    60 observations the same procedure lands at 90.2-90.8%.

    Returns None when there is not enough recent history to calibrate honestly.
    """
    if model is None:
        return None
    try:
        n_rows = len(scaled)
        # A window ending at row r predicts rows r..r+HORIZON-1, so the last window with a fully
        # observed outcome starts at n_rows - SEQ_LEN - HORIZON.
        last_start = n_rows - SEQ_LEN - HORIZON
        starts = list(range(max(0, last_start - CONFORMAL_WINDOW + 1), last_start + 1))
        if len(starts) < 20:
            return None
        X = np.stack([scaled[s : s + SEQ_LEN] for s in starts]).reshape(len(starts), SEQ_LEN, n_feat)
        y_true = np.stack([scaled[s + SEQ_LEN : s + SEQ_LEN + HORIZON, target_idx] for s in starts])
        pred = np.asarray(model.predict(X, verbose=0))
        if delta_mode:
            # Must match the weighting used for the published forecast, or the band would be
            # calibrated on a different predictor than the one it is meant to cover.
            from mean_reversion import LSTM_DELTA_WEIGHT
            pred = X[:, -1, target_idx][:, None] + LSTM_DELTA_WEIGHT * pred
        scale = scaler.scale_[target_idx]
        # Calibrate on the residuals of the forecast we actually publish. The mean-reversion
        # correction is part of that forecast, so replaying without it would size the band from a
        # different (larger-error) model and quietly over-cover.
        if reversion and reversion.get("applied"):
            phi = np.asarray(reversion.get("phi") or [], dtype=float)
            if phi.size:
                phi = np.atleast_2d(phi)[: pred.shape[1]]
                n_lags = phi.shape[1]
                anchor_rows = np.array([st + SEQ_LEN - 1 for st in starts])
                lag_mat = np.zeros((len(anchor_rows), n_lags))
                for k in range(n_lags):
                    lag_mat[:, k] = [
                        (scaled[r - k, target_idx] - scaled[r - k - 1, target_idx]) / scale
                        if (r - k - 1) >= 0 else 0.0
                        for r in anchor_rows
                    ]
                lag_mat = np.nan_to_num(lag_mat)
                pred = pred + (lag_mat @ phi.T) * scale
        err = np.abs(y_true - pred) / scale
        n = err.shape[0]
        # Finite-sample conformal quantile: ceil((n+1)(1-alpha))-th smallest absolute error.
        k = min(n - 1, int(np.ceil((n + 1) * CONFORMAL_COVERAGE)) - 1)
        return [float(np.sort(err[:, h])[k]) for h in range(err.shape[1])]
    except Exception:
        return None


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
    days: list = []
    prev = last_price if last_price > 0 else base
    for i in range(HORIZON):
        price = max(0.01, base + slope * (i + 1))
        d = anchor + pd.Timedelta(days=i + 1)
        conf = _holdout_accuracy_confidence(tm, meta, day_idx=i)
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

    out: list = []
    prev = last_price
    for i in range(HORIZON):
        price = max(0.01, prev * (1.0 + weighted_daily_pct))
        d = anchor + pd.Timedelta(days=i + 1)
        conf = _holdout_accuracy_confidence(tm, meta, day_idx=i)
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


def _payload_cache_key(meta: dict) -> tuple:
    """Identity of the inputs a forecast depends on.

    `last_date` covers new scraped/imported rows; the meta.json mtime+size covers retraining
    (new weights and a new reversion coefficient are always written together with it).
    """
    try:
        st = os.stat(META_PATH)
        meta_stamp = (int(st.st_mtime), int(st.st_size))
    except OSError:
        meta_stamp = (0, 0)
    return (meta.get("last_date"), meta_stamp, formula_mode_enabled())


def predict():
    meta = _load_meta()

    cache_key = _payload_cache_key(meta)
    cached = _PAYLOAD_CACHE.get("payload")
    if cached is not None and _PAYLOAD_CACHE.get("key") == cache_key:
        return copy.deepcopy(cached)

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

    payload = {
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
            # ── Honest headline metrics ──────────────────────────────────────────────────
            # These are the numbers to display. `hit_rate_pct` answers "how often is the
            # forecast within PHP X", `skill_vs_baseline_pct` answers "is this better than
            # assuming no change", `movement_ratio` exposes a collapsed model, and
            # `directional_pct` says whether the up/down call beats a coin flip. This block
            # used to carry only `accuracy_pct`, so any client reading /api/predictions could
            # physically only render the deprecated figure.
            "hit_rate_pct": meta.get("hit_rate_pct"),
            "skill_vs_baseline_pct": meta.get("skill_vs_baseline_pct"),
            "movement_ratio": meta.get("movement_ratio"),
            "baseline_mae_peso": primary_meta.get("baseline_mae_peso") or meta.get("baseline_mae_peso"),
            "beats_baseline": meta.get("beats_baseline"),
            # Legacy. 100 - MAE/mean_price: returns 98-99% for any model and rates the naive
            # baseline above the LSTM. Kept so pre-v4 runs still render — do not display it.
            "accuracy_pct": primary_meta.get("accuracy_pct") or meta.get("accuracy_pct"),
            "avg_accuracy_pct": avg_accuracy,
            "accuracy_pct_note": "legacy 100-MAE/mean_price; do not report - use hit_rate_pct",
            "by_target": {
                k: {
                    "mae_peso": v.get("mae_peso"),
                    "baseline_mae_peso": v.get("baseline_mae_peso"),
                    "hit_rate_pct": v.get("hit_rate_pct"),
                    "skill_vs_baseline_pct": v.get("skill_vs_baseline_pct"),
                    "directional_pct": v.get("directional_pct"),
                    "movement": v.get("movement"),
                    "beats_baseline": v.get("beats_baseline"),
                    "reversion": v.get("reversion"),
                    "accuracy_pct": v.get("accuracy_pct"),
                    # Day-1/2/3 hold-out accuracy. `accuracy_pct` is pooled over the
                    # whole horizon, so without this the UI has no way to show that
                    # a day-3 forecast is less reliable than a day-1 one.
                    "per_horizon_accuracy_pct": v.get("per_horizon_accuracy_pct"),
                    "per_horizon_mae_peso": v.get("per_horizon_mae_peso"),
                }
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

    _PAYLOAD_CACHE["key"] = cache_key
    _PAYLOAD_CACHE["payload"] = copy.deepcopy(payload)
    return payload


if __name__ == "__main__":
    import pprint
    pprint.pprint(predict())

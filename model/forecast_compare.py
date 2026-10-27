"""
AgriPricePH — Forecast vs Actual: the published forecast with the factors, the same forecast without them, and the
real DA retail price, day by day (Admin -> Forecast vs Actual; GET /api/forecast-compare).

For every day in the window, each forecast is the DAY-1 forecast made on the previous day, from data available that
day only, by the currently deployed models:
    with factors      the published adaptive ensemble (LSTM hybrid fed price + factors, ARIMA, Kalman filter)
    without factors   the identical ensemble with the price-only LSTM (model/price_only.py) in place of the
                      production one; ARIMA and the Kalman filter already use the price only
    naive             "tomorrow = today", the baseline every forecaster has to beat
The window defaults to the day after the model's training data ends (meta.json last_date), so none of these days
was seen while training. The LSTM weights are fixed; the weekday mean-reversion coefficient and the ensemble
weights are re-estimated from past data only at each origin, exactly as in the live forecast.

The result is cached in model/forecast_compare.json and rebuilt when the data, the model or the price-only models
change. Building it takes a minute or two (ARIMA is refitted at every origin).
"""

from __future__ import annotations

import json
import os
import threading
import time

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_PATH = os.path.join(HERE, "forecast_compare.json")
_lock = threading.Lock()
_building = {"running": False, "error": None, "started": None}


def _stamp() -> dict:
    import predict
    import price_only

    df = predict._get_merged_frame()     # cached for 90 s, so a page load does not rebuild the merged frame
    po_meta = {}
    try:
        po_meta = json.load(open(price_only.META_PATH, encoding="utf-8"))
    except (OSError, ValueError):
        pass
    return {"data_last_date": str(df["Date"].iloc[-1])[:10], "meta": list(predict._meta_stamp() or []),
            "price_only_trained_at": po_meta.get("trained_at")}


def build() -> dict:
    """Compute every origin the ensemble blocks cover (about the last 100 days) for all 8 rice types."""
    import joblib
    import predict
    import price_only
    from data_pipeline import RICE_COLUMNS, build_feature_frame, load_merged_frame

    if not price_only.available():
        raise RuntimeError("price-only models not trained yet: cd model && py -3.13 price_only.py")
    from keras.models import load_model

    df = load_merged_frame()
    meta = predict._load_meta()
    per_target = predict._targets_meta(meta)
    out = {"built_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "stamp": _stamp(),
           "model_last_training_date": meta.get("last_date"),
           "model_fit_end": ((meta.get("split_dates") or {}).get("train") or [None, None])[1], "types": {}}
    for target in RICE_COLUMNS:
        tmeta = per_target.get(target, {})
        use_rev = bool((tmeta.get("reversion") or {}).get("applied"))
        sub, features = build_feature_frame(df, target)

        keras_path, scaler_path, _ = predict._resolve_paths(target)
        scaler = predict._get_scaler(scaler_path)
        model = predict._get_keras(keras_path)
        ti = features.index(target)
        scaled = scaler.transform(sub[features].values.astype(float))
        with_f = predict._ensemble_block(model, True, scaled, sub, target, scaler, ti, len(features), use_rev)

        p_model, p_scaler = price_only.paths(target)
        scaler0 = joblib.load(p_scaler)
        model0 = load_model(p_model, compile=False)
        scaled0 = scaler0.transform(sub[[target]].values.astype(float))
        without = predict._ensemble_block(model0, True, scaled0, sub, target, scaler0, 0, 1, use_rev)

        ser, rows, dates = with_f["series"], with_f["rows"], with_f["dates"]
        assert list(rows) == list(without["rows"])
        days = []
        for k, r in enumerate(rows):
            if r + 1 >= len(ser):
                continue
            days.append({
                "date": pd.Timestamp(dates[r + 1]).strftime("%Y-%m-%d"),
                "actual": round(float(ser[r + 1]), 2),
                "with_factors": round(float(with_f["combined"][k, 0]), 2),
                "without_factors": round(float(without["combined"][k, 0]), 2),
                "naive": round(float(ser[r]), 2),
            })
        out["types"][target] = days
    return out


def _write(data: dict) -> None:
    tmp = CACHE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, CACHE_PATH)


def _load_cache() -> dict | None:
    try:
        with open(CACHE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _run() -> None:
    try:
        _write(build())
        _building["error"] = None
    except Exception as exc:          # reported through status(); the page shows it
        _building["error"] = str(exc)
    finally:
        _building["running"] = False


def ensure(background: bool = True) -> dict | None:
    """Cached result if it matches the current data and models; otherwise start a rebuild and return the stale
    cache (or None). The rebuild runs in a thread so a request never waits for it."""
    cache = _load_cache()
    try:
        fresh = cache is not None and cache.get("stamp") == _stamp()
    except Exception:
        fresh = cache is not None
    if fresh:
        return cache
    with _lock:
        if not _building["running"]:
            _building.update(running=True, started=time.strftime("%Y-%m-%dT%H:%M:%S"))
            if background:
                threading.Thread(target=_run, daemon=True).start()
            else:
                _run()
                return _load_cache()
    return cache


def summarise(days: list) -> dict:
    """MAE, share within PHP 0.50 / PHP 1.00, and skill vs naive for each forecast over the given days."""
    if not days:
        return {}
    a = np.array([d["actual"] for d in days])
    res = {}
    for key in ("with_factors", "without_factors", "naive"):
        e = np.abs(np.array([d[key] for d in days]) - a)
        res[key] = {"mae": round(float(e.mean()), 3), "within_050_pct": round(float((e <= 0.5).mean() * 100), 1),
                    "within_100_pct": round(float((e <= 1.0).mean() * 100), 1)}
    base = res["naive"]["mae"]
    for key in ("with_factors", "without_factors"):
        res[key]["skill_vs_naive_pct"] = round((1 - res[key]["mae"] / base) * 100, 1) if base > 0 else None
    res["mean_gap_with_vs_without"] = round(float(np.mean([abs(d["with_factors"] - d["without_factors"]) for d in days])), 3)
    res["actual_range"] = round(float(a.max() - a.min()), 2)
    return res


def window(data: dict, start: str | None, end: str | None) -> dict:
    """Restrict a cached result to [start, end] (ISO dates) and add the summaries."""
    start = start or (pd.Timestamp(data.get("model_last_training_date")) + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    types = {}
    pooled = []
    for t, days in data.get("types", {}).items():
        sel = [d for d in days if d["date"] >= start and (end is None or d["date"] <= end)]
        types[t] = {"days": sel, "summary": summarise(sel)}
        pooled.extend(sel)
    first = min((d["date"] for v in types.values() for d in v["days"]), default=None)
    last = max((d["date"] for v in types.values() for d in v["days"]), default=None)
    return {"start": first, "end": last, "n_days": len({d["date"] for d in pooled}), "types": types,
            "all_types": summarise(pooled), "built_at": data.get("built_at"),
            "model_last_training_date": data.get("model_last_training_date"), "model_fit_end": data.get("model_fit_end")}


def status() -> dict:
    return {"building": _building["running"], "error": _building["error"], "started": _building["started"]}


if __name__ == "__main__":
    import sys
    sys.path.insert(0, HERE)
    res = ensure(background=False)
    w = window(res, None, None)
    print(w["start"], w["end"], w["n_days"], json.dumps(w["all_types"], indent=1))

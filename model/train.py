# model/train.py — LSTM training for 3-day forecast (all rice types)
import json
import math
import os
import random
import shutil
import sys
import warnings

warnings.filterwarnings("ignore", message="Could not infer format")
warnings.filterwarnings("ignore", category=UserWarning, module="google.protobuf")

import numpy as np

from data_pipeline import (
    HORIZON,
    RICE_COLUMNS,
    SEQ_LEN,
    TARGET_COLUMN,
    build_feature_frame,
    load_merged_frame,
    make_sequences,
)

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")

MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
LSTM_MODELS_DIR = os.path.join(MODEL_DIR, "lstm_models")
MODEL_PATH = os.path.join(MODEL_DIR, "lstm_model.keras")
SCALER_PATH = os.path.join(MODEL_DIR, "scaler.joblib")
META_PATH = os.path.join(MODEL_DIR, "meta.json")

EPOCHS = int(os.environ.get("AGRIPRICE_EPOCHS", "100"))
BATCH_SIZE = 32
# Anchored-delta mode: model predicts the price CHANGE from the last observed value in the
# window (instead of the absolute level). Anchors forecasts to the last price like the naive
# baseline does, removing level-bias — it roughly halves test MAE vs. level mode, so it is the
# DEFAULT. It must stay default-on: the web "Start Training" button inherits the server env and
# would otherwise silently retrain the worse level-mode model. Opt out with AGRIPRICE_DELTA_MODE=0.
DELTA_MODE = os.environ.get("AGRIPRICE_DELTA_MODE", "1").strip().lower() in ("1", "true", "yes")

# Reproducibility. Without a fixed seed, weight init and dropout differ every run, so two runs on
# identical data report different MAE — and a run-over-run "improvement" can be pure luck. A
# capstone panel can reasonably ask for a rerun that reproduces the reported numbers.
SEED = int(os.environ.get("AGRIPRICE_SEED", "42"))

# ── Regime-aware split ────────────────────────────────────────────────────────
# The retail series is not one homogeneous dataset. Before 2025-Q2 the source published weekly (or
# was reconstructed from weekly figures) and the merge forward-fills to daily, so 78-100% of rows
# repeat the previous day's price. From 2025-Q2 onward the source is genuinely daily and only
# ~3-11% of rows repeat. Measured flatness of locWellMilled by quarter:
#     2022Q1-2023Q4: 93-100% flat      2024Q1-2024Q4: 77-86% flat
#     2025Q1: 57% flat                 2025Q2 onward:  2-11% flat
#
# A plain chronological 70/15/15 on that series puts TRAIN at 81% flat, VALIDATION at 88% flat and
# TEST at 26% flat. Early stopping then selects whichever weights score best on an almost-static
# validation set — i.e. it actively rewards a model that predicts "no change" — and the result is
# scored on a period where prices actually move. That is a train/serve regime mismatch, not a
# modelling choice.
#
# So validation and test are both drawn from the daily-observation era. Training still uses the
# full history (it is all the history there is) and the mixed-regime training set is disclosed in
# meta.json via `split_policy` + `train_flat_pct`.
ACTIVE_FROM = os.environ.get("AGRIPRICE_ACTIVE_FROM", "2025-04-01")
# Share of the active era reserved for validation; the remainder is the held-out test set.
ACTIVE_VAL_FRACTION = float(os.environ.get("AGRIPRICE_ACTIVE_VAL_FRACTION", "0.35"))
# Set AGRIPRICE_LEGACY_SPLIT=1 to reproduce pre-fix runs (chronological 70/15/15 over everything).
LEGACY_SPLIT = os.environ.get("AGRIPRICE_LEGACY_SPLIT", "0").strip().lower() in ("1", "true", "yes")


def _seed_everything(seed: int = SEED) -> None:
    """Seed python/numpy/tensorflow so a rerun reproduces the reported metrics."""
    os.environ["PYTHONHASHSEED"] = str(seed)
    random.seed(seed)
    np.random.seed(seed)
    try:
        import tensorflow as tf

        tf.random.set_seed(seed)
        tf.keras.utils.set_random_seed(seed)
    except Exception:
        pass


def _seq_dates(sub, n_seq):
    """Date each sequence forecasts from — row i+SEQ_LEN, the first forecast day."""
    import pandas as pd

    dates = pd.to_datetime(sub["Date"], errors="coerce") if "Date" in sub.columns else None
    if dates is None:
        return None
    return dates.iloc[SEQ_LEN : SEQ_LEN + n_seq].reset_index(drop=True)


def _split_indices(sub, n_seq: int, target: str) -> tuple[int, int, str]:
    """(train_end, val_end, policy). Validation and test both come from the daily-observation era.

    Falls back to the historical chronological 70/15/15 when the active era is missing or too
    small to split — better a disclosed legacy split than a two-sequence test set.
    """
    legacy = (int(n_seq * 0.70), int(n_seq * 0.85), "chronological_70_15_15")
    if LEGACY_SPLIT:
        return legacy
    seq_dates = _seq_dates(sub, n_seq)
    if seq_dates is None or seq_dates.isna().all():
        return legacy

    import pandas as pd

    cutoff = pd.Timestamp(ACTIVE_FROM)
    active = int((seq_dates >= cutoff).sum())
    # Need a usable active era and enough history left to train on.
    if active < 60 or (n_seq - active) < 200:
        return legacy
    i_tr = n_seq - active
    i_va = i_tr + max(20, int(active * ACTIVE_VAL_FRACTION))
    if (n_seq - i_va) < 30:
        return legacy
    return i_tr, i_va, f"regime_aware_active_from_{ACTIVE_FROM}"


def _split_dates(sub, i_tr: int, i_va: int, n_seq: int) -> dict:
    seq_dates = _seq_dates(sub, n_seq)
    if seq_dates is None or seq_dates.isna().all():
        return {}

    def span(a, b):
        s = seq_dates.iloc[a:b].dropna()
        return None if s.empty else [str(s.iloc[0].date()), str(s.iloc[-1].date())]

    return {"train": span(0, i_tr), "val": span(i_tr, i_va), "test": span(i_va, n_seq)}


def _flat_pct_by_split(sub, target: str, i_tr: int, i_va: int, n_seq: int) -> dict:
    """% of each split's forecast days that merely repeat the previous day's price.

    This is the number that exposes a regime mismatch at a glance: when validation is far flatter
    than test, early stopping has been selecting for the wrong behaviour.
    """
    import pandas as pd

    vals = pd.to_numeric(sub[target], errors="coerce")
    flat = (vals.diff().abs() < 1e-9).iloc[SEQ_LEN : SEQ_LEN + n_seq].reset_index(drop=True)

    def pct(a, b):
        s = flat.iloc[a:b]
        return None if s.empty else round(float(s.mean() * 100), 1)

    return {"train": pct(0, i_tr), "val": pct(i_tr, i_va), "test": pct(i_va, n_seq)}


def _hit_rate_pct(y_true, y_pred, scaler, target_idx, tolerances=(0.25, 0.5, 1.0, 1.5, 2.0)) -> dict:
    """% of forecasts landing within N pesos of the actual price, per forecast day.

    Reported instead of the old `accuracy_pct` (= 100 - MAE/mean_price*100), which cannot
    distinguish a trained model from a trivial one: because rice costs ~P45-60/kg and errors are
    ~P0.50, that formula returns 98-99% for anything, and scores the naive baseline HIGHER than
    the LSTM on all 8 rice types. A hit rate states its threshold, so it means something.
    """
    scale = scaler.scale_[target_idx]
    err = np.abs(y_true - y_pred) / scale
    return {
        f"{t:.2f}": [round(float((err[:, h] <= t).mean() * 100), 1) for h in range(err.shape[1])]
        for t in tolerances
    }


def _directional_pct(y_true, y_pred, anchors, scaler, target_idx) -> list:
    """% of forecasts that get the up/down direction right, per day.

    Days where the price did not move are EXCLUDED: np.sign(0) never matches a non-zero
    prediction, so counting them makes any model look ~35% when the honest figure is ~50%.
    """
    scale = scaler.scale_[target_idx]
    true_d = (y_true - anchors[:, None]) / scale
    pred_d = (y_pred - anchors[:, None]) / scale
    out = []
    for h in range(true_d.shape[1]):
        moved = np.abs(true_d[:, h]) > 1e-6
        out.append(
            round(float(np.mean(np.sign(true_d[moved, h]) == np.sign(pred_d[moved, h])) * 100), 1)
            if moved.any()
            else None
        )
    return out


def _movement_ratio(y_true, y_pred, anchors, scaler, target_idx) -> dict:
    """How far the model actually moves off the anchor, vs how far the price really moves.

    The single most diagnostic number in this file. A model that has collapsed to "predict no
    change" is numerically identical to the naive baseline, and every error metric will report
    them as tied while hiding the reason. If `ratio` is near 0 the model is not forecasting, it is
    copying — and no amount of metric tuning will change that.
    """
    scale = scaler.scale_[target_idx]
    pred_move = float(np.abs((y_pred - anchors[:, None]) / scale).mean())
    true_move = float(np.abs((y_true - anchors[:, None]) / scale).mean())
    return {
        "pred_abs_change_peso": round(pred_move, 4),
        "true_abs_change_peso": round(true_move, 4),
        "ratio": round(pred_move / true_move, 4) if true_move > 1e-9 else None,
    }


def _lstm_ablation(y_true, level_pred, anchors, corr_peso, scaler, target_idx) -> dict | None:
    """Does the neural network earn its place, or is the reversion coefficient doing all the work?

    MAE cannot answer this. Removing the network moves skill by ~0.02 percentage points, which is
    inside run-to-run noise, so the honest MAE verdict is "indistinguishable" — not "it helps".
    Direction can answer it, but only if the comparison is set up correctly, and the naive setup
    is badly misleading:

      On ~13% of moving-price forecasts the last observed change is exactly zero. The reversion
      term is then structurally silent (phi * 0 == 0), sign(0) matches nothing, and those rows are
      scored as wrong for the reversion-only model no matter what the price did. The network, by
      contributing any non-zero nudge, "wins" all of them. Measured naively that inflates the
      network's directional contribution by ~9 points; measured on that subset alone the network
      scores 50.7%, i.e. it is breaking the tie by coin flip, not by skill.

    So this restricts to GENUINE-SIGNAL forecasts (last change non-zero, price actually moved) and
    pairs the two predictors per forecast, counting only the rows where they disagree — McNemar's
    test. Discordant pairs are the only rows carrying information about which predictor is better.
    p is exact for 1 degree of freedom via erfc; no scipy dependency.
    """
    scale = scaler.scale_[target_idx]
    if corr_peso is None:
        return None  # reversion never applied — there is no second predictor to compare against

    true_d = (y_true - anchors[:, None]) / scale
    full_d = (level_pred - anchors[:, None]) / scale
    rev_d = corr_peso / scale                      # reversion-only, i.e. LSTM weight forced to 0

    lag_zero = np.abs(rev_d) <= 1e-12              # reversion silent => tie it cannot break
    signal = (np.abs(true_d) > 1e-6) & ~lag_zero
    if signal.sum() < 30:
        return None

    ok_full = np.sign(full_d[signal]) == np.sign(true_d[signal])
    ok_rev = np.sign(rev_d[signal]) == np.sign(true_d[signal])
    fixes = int((~ok_rev & ok_full).sum())         # network turns a wrong call right
    breaks = int((ok_rev & ~ok_full).sum())        # network turns a right call wrong
    n_disc = fixes + breaks
    if n_disc == 0:
        return None
    chi2 = (abs(fixes - breaks) - 1) ** 2 / n_disc  # Yates-corrected McNemar
    p_value = math.erfc(math.sqrt(chi2 / 2.0))      # exact upper tail of chi-square(1)

    tie = (np.abs(true_d) > 1e-6) & lag_zero
    return {
        "test": "mcnemar_paired_directional",
        "subset": "genuine_signal_only",
        "n_scored": int(signal.sum()),
        "lstm_fixes": fixes,
        "lstm_breaks": breaks,
        "n_discordant": n_disc,
        "chi_square": round(float(chi2), 3),
        "p_value": float(f"{p_value:.4g}"),
        "significant_at_05": bool(p_value < 0.05 and fixes > breaks),
        "directional_pct_with_lstm": round(float(ok_full.mean() * 100), 1),
        "directional_pct_reversion_only": round(float(ok_rev.mean() * 100), 1),
        # Reported so nobody re-derives the inflated number from the unrestricted subset.
        "excluded_tie_rows": int(tie.sum()),
        "tie_row_share_pct": round(float(tie.sum() / max(int((np.abs(true_d) > 1e-6).sum()), 1) * 100), 1),
    }


def _save_meta(meta: dict) -> None:
    with open(META_PATH, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)


def _model_paths(target: str) -> tuple[str, str, str]:
    os.makedirs(LSTM_MODELS_DIR, exist_ok=True)
    return (
        os.path.join(LSTM_MODELS_DIR, f"{target}.keras"),
        os.path.join(LSTM_MODELS_DIR, f"{target}_scaler.joblib"),
        os.path.join(LSTM_MODELS_DIR, f"{target}_mlp.joblib"),
    )


def _mae_in_peso(y_true, y_pred, scaler, target_idx):
    scale = scaler.scale_[target_idx]
    return float(np.mean(np.abs((y_true - y_pred) / scale)))


def _rmse_in_peso(y_true, y_pred, scaler, target_idx):
    scale = scaler.scale_[target_idx]
    return float(np.sqrt(np.mean(((y_true - y_pred) / scale) ** 2)))


def _per_horizon_mae_peso(y_true, y_pred, scaler, target_idx) -> list:
    """MAE broken out per forecast-ahead day (index 0 = tomorrow, 1 = day after, ...), instead of
    one number pooled across all HORIZON steps. `mae_peso` above hides that day-3 is genuinely
    harder to forecast than day-1 — this is what the per-day 'confidence' shown to users should
    actually be based on, rather than reusing one aggregate figure for every day."""
    scale = scaler.scale_[target_idx]
    err = np.abs(y_true - y_pred) / scale  # shape (n_test, HORIZON)
    return [round(float(np.mean(err[:, i])), 4) for i in range(err.shape[1])]


def _persistence_baseline(X_test, y_test, target_idx, scaler) -> dict:
    """Naive persistence: forecast every horizon step as the last observed value.

    This is the paper's mandatory benchmark — if the LSTM cannot beat it, the added
    model complexity is not justified.
    """
    last_scaled = X_test[:, -1, target_idx]
    pred = np.repeat(last_scaled[:, None], y_test.shape[1], axis=1)
    return {
        "mae_peso": _mae_in_peso(y_test, pred, scaler, target_idx),
        "rmse_peso": _rmse_in_peso(y_test, pred, scaler, target_idx),
    }


def _adf_pvalue(series) -> float | None:
    """Augmented Dickey-Fuller p-value on the raw target series (None if unavailable)."""
    try:
        from statsmodels.tsa.stattools import adfuller
    except Exception:
        return None
    vals = np.asarray(series, dtype=float)
    vals = vals[~np.isnan(vals)]
    if len(vals) < 20:
        return None
    try:
        return float(adfuller(vals, autolag="AIC")[1])
    except Exception:
        return None


def _arima_baseline(raw_target, i_va, seq_len, horizon, order=(1, 1, 1)) -> dict | None:
    """Walk-forward ARIMA multi-step baseline over the test region (raw-peso MAE/RMSE).

    Second baseline the paper's panel expects. Uses append(refit=False) so params are
    estimated once on train+val and the origin rolls forward one day at a time — fast.
    """
    try:
        from statsmodels.tsa.arima.model import ARIMA
    except Exception:
        return None
    y = np.asarray(raw_target, dtype=float)
    n = len(y)
    start = i_va + seq_len  # observations available before the first test forecast origin
    if start < 30 or start + horizon > n:
        return None
    warnings.filterwarnings("ignore")
    try:
        res = ARIMA(y[:start], order=order).fit()
    except Exception:
        return None
    errs, origin = [], start
    while origin + horizon <= n:
        try:
            fc = np.asarray(res.forecast(horizon), dtype=float)
        except Exception:
            break
        errs.append(np.abs(fc - y[origin:origin + horizon]))
        try:
            res = res.append(y[origin:origin + 1], refit=False)
        except Exception:
            break
        origin += 1
    if not errs:
        return None
    e = np.concatenate(errs)
    return {
        "order": list(order),
        "mae_peso": round(float(np.mean(e)), 4),
        "rmse_peso": round(float(np.sqrt(np.mean(e ** 2))), 4),
        "n": int(len(e) // horizon),
    }


def _to_peso(scaled_vals, scaler, target_idx):
    """Inverse-transform scaled target values back to PHP/kg."""
    scale = scaler.scale_[target_idx]
    mn = scaler.min_[target_idx]
    return (np.asarray(scaled_vals) - mn) / scale


def _extra_metrics(y_level_test, level_pred, scaler, target_idx) -> dict:
    """MAPE (%) and R^2 in peso space, complementing MAE/RMSE."""
    yt = _to_peso(y_level_test, scaler, target_idx).ravel()
    yp = _to_peso(level_pred, scaler, target_idx).ravel()
    mask = np.abs(yt) > 1e-9
    mape = float(np.mean(np.abs((yt[mask] - yp[mask]) / yt[mask])) * 100.0) if mask.any() else None
    ss_res = float(np.sum((yt - yp) ** 2))
    ss_tot = float(np.sum((yt - np.mean(yt)) ** 2))
    r2 = (1.0 - ss_res / ss_tot) if ss_tot > 1e-12 else None
    return {
        "mape_pct": round(mape, 4) if mape is not None else None,
        "r2": round(r2, 4) if r2 is not None else None,
    }


def _rolling_eval(y_level_test, level_pred, scaler, target_idx, k: int = 5) -> dict | None:
    """Rolling-origin evaluation: MAE across K chronological blocks of the held-out test set
    (fixed model, no refit) — a cheap temporal-robustness check. Reports per-block MAE + mean/std."""
    scale = scaler.scale_[target_idx]
    per_sample = (np.abs(y_level_test - level_pred) / scale).mean(axis=1)  # peso MAE per test point
    n = len(per_sample)
    if n < 4:
        return None
    k = min(k, n)
    blocks = np.array_split(per_sample, k)
    maes = [round(float(b.mean()), 4) for b in blocks if len(b)]
    return {
        "method": "blocked rolling-origin over held-out test (no refit)",
        "k": len(maes), "block_mae": maes,
        "mean": round(float(np.mean(maes)), 4), "std": round(float(np.std(maes)), 4),
    }


def _shock_metrics(y_level_test, level_pred, anchors_test, scaler, target_idx, pct=90) -> dict | None:
    """LSTM vs persistence on the most volatile test points (where the price actually moved).

    This is the paper's real use case — 'lead-time awareness' before price shocks — where the
    naive baseline is weakest. All errors in peso.
    """
    if len(y_level_test) == 0:
        return None
    scale = scaler.scale_[target_idx]
    move_peso = np.abs(y_level_test - anchors_test[:, None]) / scale
    sample_move = move_peso.max(axis=1)
    thr = float(np.percentile(sample_move, pct))
    mask = sample_move >= thr
    if int(mask.sum()) < 3:
        return None
    lstm = float(np.mean(np.abs(y_level_test[mask] - level_pred[mask]) / scale))
    base = float(np.mean(np.abs(y_level_test[mask] - anchors_test[mask, None]) / scale))
    return {
        "pct": pct,
        "threshold_peso": round(thr, 4),
        "count": int(mask.sum()),
        "lstm_mae_peso": round(lstm, 4),
        "baseline_mae_peso": round(base, 4),
        "beats_baseline": bool(lstm < base),
    }


def _train_sklearn(X_train, y_train, X_val, y_val, X_test, y_test, scaler, target_idx, mlp_path, scaler_path):
    import joblib
    from sklearn.neural_network import MLPRegressor

    mlp = MLPRegressor(
        hidden_layer_sizes=(128, 64, 32),
        max_iter=EPOCHS,
        early_stopping=True,
        validation_fraction=0.2,
        random_state=42,
        verbose=False,
    )
    # sklearn MLP carves its own internal validation split; give it train+val, keep test held out.
    X_fit = np.concatenate([X_train, X_val], axis=0) if len(X_val) else X_train
    y_fit = np.concatenate([y_train, y_val], axis=0) if len(y_val) else y_train
    mlp.fit(X_fit.reshape(X_fit.shape[0], -1), y_fit)
    joblib.dump(mlp, mlp_path)
    joblib.dump(scaler, scaler_path)
    pred = np.atleast_2d(mlp.predict(X_test.reshape(X_test.shape[0], -1)))
    return {"backend": "sklearn", "pred": pred}


def _train_tensorflow(
    X_train,
    y_train,
    X_val,
    y_val,
    X_test,
    y_test,
    scaler,
    target_idx,
    n_feat,
    model_path,
    scaler_path,
    target_name: str = "",
):
    import tensorflow as tf
    from keras.callbacks import EarlyStopping, ModelCheckpoint

    class _RetryingModelCheckpoint(ModelCheckpoint):
        """ModelCheckpoint that survives a transient OSError while writing the .keras file.

        On Windows the per-epoch checkpoint write intermittently fails with
        `OSError: [Errno 22] Invalid argument` — real-time antivirus (or any indexer) briefly
        holding the handle on a file that is rewritten every time val_loss improves. It is
        transient and lands on a different rice type each run, so a whole 8-target training run
        would abort several epochs from the end for a reason unrelated to the model. Retry with a
        short backoff instead of losing the run.
        """

        def _save_model(self, *args, **kwargs):
            import time as _time
            last = None
            for attempt in range(5):
                try:
                    return super()._save_model(*args, **kwargs)
                except OSError as exc:
                    last = exc
                    _time.sleep(0.4 * (attempt + 1))
            print(f"[WARN] checkpoint write failed after retries ({last}); continuing — "
                  f"EarlyStopping(restore_best_weights=True) still holds the best weights.")
            return None

    from keras.layers import Dense, Dropout, LSTM
    from keras.models import Sequential

    import joblib

    model = Sequential([
        LSTM(64, return_sequences=True, input_shape=(SEQ_LEN, n_feat)),
        Dropout(0.2),
        LSTM(32, return_sequences=False),
        Dropout(0.2),
        Dense(16, activation="relu"),
        Dense(HORIZON),
    ])
    model.compile(optimizer="adam", loss="mse", metrics=["mae"])
    joblib.dump(scaler, scaler_path)

    label = target_name or "model"

    class EpochLogger(tf.keras.callbacks.Callback):
        def on_epoch_end(self, epoch, logs=None):
            logs = logs or {}
            print(
                f"[EPOCH] {label} | {epoch + 1}/{EPOCHS} | "
                f"loss: {logs.get('loss', 0):.4f} | "
                f"val_loss: {logs.get('val_loss', 0):.4f} | "
                f"mae: {logs.get('mae', 0):.4f}",
                flush=True,
            )

    model.fit(
        X_train,
        y_train,
        validation_data=(X_val, y_val),
        epochs=EPOCHS,
        batch_size=BATCH_SIZE,
        callbacks=[
            EpochLogger(),
            _RetryingModelCheckpoint(model_path, save_best_only=True, monitor="val_loss", verbose=0),
            EarlyStopping(
                monitor="val_loss",
                patience=8,
                min_delta=1e-4,
                restore_best_weights=True,
                verbose=0,
            ),
        ],
        verbose=0,
    )

    pred = model.predict(X_test, verbose=0)
    return {"backend": "tensorflow", "pred": pred}


def _train_one_target(df, target: str, use_tensorflow: bool) -> dict | None:
    from sklearn.preprocessing import MinMaxScaler

    sub, features = build_feature_frame(df, target)
    if len(sub) < SEQ_LEN + HORIZON + 50:
        print(f"[SKIP] {target}: not enough rows ({len(sub)}).")
        return None

    target_idx = features.index(target)
    raw = sub[features].values.astype(float)
    n_seq = len(raw) - SEQ_LEN - HORIZON + 1
    if n_seq < 50:
        print(f"[SKIP] {target}: not enough sequences ({n_seq}).")
        return None

    # Chronological split — no shuffle, no leakage. Sequence i covers rows [i, i+SEQ_LEN) and is
    # scored on rows [i+SEQ_LEN, i+SEQ_LEN+HORIZON), so a sequence "belongs" to the date at
    # i+SEQ_LEN: that is the first day it forecasts.
    i_tr, i_va, split_policy = _split_indices(sub, n_seq, target)
    if i_tr < 50 or (i_va - i_tr) < 5 or (n_seq - i_va) < 5:
        print(f"[SKIP] {target}: split too small (n_seq={n_seq}, policy={split_policy}).")
        return None

    # Fit the scaler on TRAIN rows only, then transform everything (prevents val/test leakage).
    train_row_end = i_tr + SEQ_LEN
    scaler = MinMaxScaler().fit(raw[:train_row_end])
    scaled = scaler.transform(raw)
    X, y_level = make_sequences(scaled, target_idx, SEQ_LEN, HORIZON)

    # Anchor = last observed (scaled) target value in each input window.
    anchors = X[:, -1, target_idx]
    # Model target: absolute level, or delta-from-anchor when DELTA_MODE is on.
    y = (y_level - anchors[:, None]) if DELTA_MODE else y_level

    X_train, y_train = X[:i_tr], y[:i_tr]
    X_val, y_val = X[i_tr:i_va], y[i_tr:i_va]
    X_test, y_test = X[i_va:], y[i_va:]
    y_level_test = y_level[i_va:]
    anchors_test = anchors[i_va:]
    split_dates = _split_dates(sub, i_tr, i_va, n_seq)
    flat_pct = _flat_pct_by_split(sub, target, i_tr, i_va, n_seq)

    keras_path, scaler_path, mlp_path = _model_paths(target)
    print(
        f"[INFO] {target}: train={len(X_train)} val={len(X_val)} test={len(X_test)} "
        f"n_features={len(features)} delta_mode={DELTA_MODE} split={split_policy}"
    )
    if flat_pct:
        print(
            f"[INFO] {target}: repeated-price days — train {flat_pct.get('train')}% "
            f"val {flat_pct.get('val')}% test {flat_pct.get('test')}%"
        )

    if use_tensorflow:
        result = _train_tensorflow(
            X_train, y_train, X_val, y_val, X_test, y_test, scaler, target_idx,
            len(features), keras_path, scaler_path, target_name=target,
        )
        print(f"[SAVED] {keras_path}")
    else:
        result = _train_sklearn(
            X_train, y_train, X_val, y_val, X_test, y_test, scaler, target_idx, mlp_path, scaler_path
        )
        print(f"[SAVED] {mlp_path}")

    # Reconstruct absolute-level predictions (add anchor back in delta mode), then score.
    pred = np.asarray(result["pred"])
    if DELTA_MODE:
        # The network's marginal contribution to the delta is negative (see
        # model/mean_reversion.py); its weight is a disclosed, configurable parameter.
        from mean_reversion import LSTM_DELTA_WEIGHT
        level_pred = anchors_test[:, None] + LSTM_DELTA_WEIGHT * pred
    else:
        level_pred = pred

    # ── Mean-reversion correction ────────────────────────────────────────────────────────────
    # The network alone collapses to a near-constant forecast (movement ratio ~0.07) because
    # ~73% of its training targets are forward-filled zeros. The active-regime first differences
    # are strongly negatively autocorrelated (Ljung-Box p < 0.0001 on all 8 types), so one
    # coefficient per horizon recovers the signal the network cannot. Fit on the VALIDATION
    # window only — the newest in-regime data that precedes test — so the test set stays clean.
    # See model/mean_reversion.py for the full rationale and the significance gate.
    import pandas as pd
    from mean_reversion import fit_reversion

    price_series = pd.to_numeric(sub[target], errors="coerce").values.astype(float)
    # Reported coefficient (validation-window fit) is what gets stored in meta.json for reference
    # and for any consumer that cannot re-fit. Scoring below uses the ROLLING re-fit, because that
    # is what inference actually applies — the two must not diverge.
    reversion = fit_reversion(price_series, i_tr + SEQ_LEN, i_va + SEQ_LEN, HORIZON)
    corr_peso = None
    if reversion.get("applied"):
        from mean_reversion import ROLLING_WINDOW, rolling_phi

        test_rows = np.arange(i_va + SEQ_LEN - 1, i_va + SEQ_LEN - 1 + len(level_pred))
        corr = np.zeros((len(test_rows), level_pred.shape[1]))
        for i, r in enumerate(test_rows):
            phi, _ = rolling_phi(price_series, r, HORIZON)   # past data only
            n_lags = phi.shape[1]
            lags = np.array([
                (price_series[r - k] - price_series[r - k - 1]) if (r - k - 1) >= 0 else 0.0
                for k in range(n_lags)
            ])
            corr[i] = np.nan_to_num(lags) @ phi.T[:, : level_pred.shape[1]]
        corr_peso = corr * scaler.scale_[target_idx]
        level_pred = level_pred + corr_peso
        reversion["rolling_window"] = ROLLING_WINDOW
        reversion["scored_with"] = "rolling"

    metrics = {
        "backend": result["backend"],
        "mae_peso": _mae_in_peso(y_level_test, level_pred, scaler, target_idx),
        "rmse_peso": _rmse_in_peso(y_level_test, level_pred, scaler, target_idx),
    }

    # Naive persistence baseline: forecast every horizon step = last observed value (delta 0).
    baseline = _persistence_baseline(X_test, y_level_test, target_idx, scaler)
    adf_p = _adf_pvalue(sub[target].values)
    arima = _arima_baseline(sub[target].values.astype(float), i_va, SEQ_LEN, HORIZON)
    shock = _shock_metrics(y_level_test, level_pred, anchors_test, scaler, target_idx)
    extra = _extra_metrics(y_level_test, level_pred, scaler, target_idx)
    rolling = _rolling_eval(y_level_test, level_pred, scaler, target_idx)
    per_horizon_mae = _per_horizon_mae_peso(y_level_test, level_pred, scaler, target_idx)

    baseline_pred = np.repeat(anchors_test[:, None], HORIZON, axis=1)
    hit_rate = _hit_rate_pct(y_level_test, level_pred, scaler, target_idx)
    baseline_hit = _hit_rate_pct(y_level_test, baseline_pred, scaler, target_idx)
    directional = _directional_pct(y_level_test, level_pred, anchors_test, scaler, target_idx)
    movement = _movement_ratio(y_level_test, level_pred, anchors_test, scaler, target_idx)
    # Whether the titular network contributes anything the reversion coefficient does not.
    lstm_ablation = _lstm_ablation(
        y_level_test, level_pred, anchors_test, corr_peso, scaler, target_idx
    )
    # Skill vs the naive baseline: >0 means the model beat "tomorrow = today". Unlike raw MAE this
    # is comparable across runs even when the test window's volatility changes.
    skill = (
        round((1.0 - metrics["mae_peso"] / baseline["mae_peso"]) * 100, 2)
        if baseline["mae_peso"] > 1e-9
        else None
    )

    mean_price = float(sub[target].mean())
    accuracy = max(0.0, min(99.9, 100.0 - (metrics["mae_peso"] / max(mean_price, 1) * 100)))
    baseline_acc = max(0.0, min(99.9, 100.0 - (baseline["mae_peso"] / max(mean_price, 1) * 100)))
    per_horizon_accuracy = [
        round(max(0.0, min(99.9, 100.0 - (m / max(mean_price, 1) * 100))), 2) for m in per_horizon_mae
    ]
    return {
        "target": target,
        "features": features,
        "backend": metrics["backend"],
        "delta_mode": DELTA_MODE,
        "seed": SEED,
        "mae_peso": round(metrics["mae_peso"], 4),
        "rmse_peso": round(metrics["rmse_peso"], 4),
        "mape_pct": extra["mape_pct"],
        "r2": extra["r2"],
        "rolling_eval": rolling,
        # `accuracy_pct` is kept only so older runs/dashboards keep rendering. It is NOT a
        # meaningful score — see _hit_rate_pct. Use hit_rate_pct / skill_vs_baseline_pct instead.
        "accuracy_pct": round(accuracy, 2),
        "accuracy_pct_note": "legacy 100-MAE/mean_price; scores the naive baseline higher than the model — do not report",
        "hit_rate_pct": hit_rate,
        "baseline_hit_rate_pct": baseline_hit,
        "directional_pct": directional,
        "lstm_ablation": lstm_ablation,
        "movement": movement,
        "reversion": reversion,
        "skill_vs_baseline_pct": skill,
        "per_horizon_mae_peso": per_horizon_mae,
        "per_horizon_accuracy_pct": per_horizon_accuracy,
        "baseline_mae_peso": round(baseline["mae_peso"], 4),
        "baseline_rmse_peso": round(baseline["rmse_peso"], 4),
        "baseline_accuracy_pct": round(baseline_acc, 2),
        "beats_baseline": bool(metrics["mae_peso"] < baseline["mae_peso"]),
        "arima": arima,
        "beats_arima": (bool(metrics["mae_peso"] < arima["mae_peso"]) if arima else None),
        "shock": shock,
        "adf_pvalue": (round(adf_p, 4) if adf_p is not None else None),
        "train_samples": len(X_train),
        "val_samples": len(X_val),
        "test_samples": len(X_test),
        "split_policy": split_policy,
        "split_dates": split_dates,
        "flat_pct_by_split": flat_pct,
    }


def _training_target_list() -> list[str]:
    """
    Default: all 8 rice types (full model training).
    Quick mode: AGRIPRICE_TRAIN_ALL=0 + AGRIPRICE_TRAIN_TARGET=locWellMilled
    """
    explicit = os.environ.get("AGRIPRICE_TRAIN_TARGETS", "").strip()
    if explicit:
        names = [t.strip() for t in explicit.split(",") if t.strip()]
        return [t for t in names if t in RICE_COLUMNS]

    train_all_env = os.environ.get("AGRIPRICE_TRAIN_ALL", "1").strip().lower()
    if train_all_env in ("0", "false", "no"):
        single = os.environ.get("AGRIPRICE_TRAIN_TARGET", TARGET_COLUMN).strip()
        return [single] if single in RICE_COLUMNS else [TARGET_COLUMN]

    return list(RICE_COLUMNS)


def main():
    _seed_everything()
    print(f"[INFO] Seed: {SEED} (set AGRIPRICE_SEED to change) — runs are reproducible")
    print("[INFO] Loading merged dataset from database...")
    df = load_merged_frame()
    print(
        f"[INFO] Loaded {len(df)} rows. "
        f"Date range: {df['Date'].iloc[0].date()} to {df['Date'].iloc[-1].date()}"
    )
    train_list = _training_target_list()
    print(f"[INFO] Training LSTM for {len(train_list)} rice type(s): {', '.join(train_list)}")
    print("=" * 47)

    try:
        import tensorflow  # noqa: F401
        use_tf = True
        print("[INFO] Backend: TensorFlow LSTM")
    except ImportError:
        use_tf = False
        print("[INFO] TensorFlow not available — sklearn MLP per type")

    targets_meta: dict = {}
    total = len(train_list)
    for i, target in enumerate(train_list, 1):
        print(f"\n[TARGET] {i}/{total} {target}")
        print("-" * 47)
        entry = _train_one_target(df, target, use_tf)
        if entry:
            targets_meta[target] = entry
            mv = entry.get("movement") or {}
            hit = (entry.get("hit_rate_pct") or {}).get("1.00") or []
            print(
                f"[DONE] {target} | MAE PHP {entry['mae_peso']:.4f} | "
                f"within PHP1.00 {hit[0] if hit else '—'}% (day 1) | "
                f"skill vs naive {entry.get('skill_vs_baseline_pct')}% | "
                f"movement ratio {mv.get('ratio')}"
            )
            if mv.get("ratio") is not None and mv["ratio"] < 0.25:
                print(
                    f"[WARN] {target}: model moves only {mv['ratio'] * 100:.1f}% as much as the "
                    f"real price (PHP {mv['pred_abs_change_peso']} vs PHP {mv['true_abs_change_peso']}) "
                    f"— it is close to reproducing the naive forecast."
                )

    if not targets_meta:
        print("[ERROR] No rice type could be trained.")
        sys.exit(1)

    primary = targets_meta.get(TARGET_COLUMN) or next(iter(targets_meta.values()))
    acc_values = [float(v.get("accuracy_pct", 0)) for v in targets_meta.values() if v.get("accuracy_pct") is not None]
    avg_accuracy = round(sum(acc_values) / len(acc_values), 2) if acc_values else primary.get("accuracy_pct")
    if TARGET_COLUMN in targets_meta:
        keras_path, scaler_path, _ = _model_paths(TARGET_COLUMN)
        if use_tf and os.path.exists(keras_path):
            shutil.copy2(keras_path, MODEL_PATH)
            shutil.copy2(scaler_path, SCALER_PATH)
        elif not use_tf:
            src_mlp = os.path.join(LSTM_MODELS_DIR, f"{TARGET_COLUMN}_mlp.joblib")
            if os.path.exists(src_mlp):
                shutil.copy2(src_mlp, os.path.join(MODEL_DIR, "rice_mlp.joblib"))
            if os.path.exists(scaler_path):
                shutil.copy2(scaler_path, SCALER_PATH)

    def _avg(key):
        vals = [v.get(key) for v in targets_meta.values() if v.get(key) is not None]
        return round(sum(map(float, vals)) / len(vals), 2) if vals else None

    def _avg_hit(tol):
        rows = [
            (v.get("hit_rate_pct") or {}).get(tol)
            for v in targets_meta.values()
            if (v.get("hit_rate_pct") or {}).get(tol)
        ]
        if not rows:
            return None
        return [round(sum(r[h] for r in rows) / len(rows), 1) for h in range(len(rows[0]))]

    def _pooled_ablation():
        """Pool the per-type McNemar counts into one system-level verdict.

        Pooling the 2x2 counts (rather than averaging 8 p-values) is what makes the result
        reportable: each rice type on its own has too few discordant pairs to reach significance,
        while the pooled table has enough. All 8 types share one architecture and one horizon, so
        they are replications of the same comparison, not 8 unrelated experiments.
        """
        rows = [v.get("lstm_ablation") for v in targets_meta.values() if v.get("lstm_ablation")]
        if not rows:
            return None
        fixes = sum(r["lstm_fixes"] for r in rows)
        breaks = sum(r["lstm_breaks"] for r in rows)
        n_disc = fixes + breaks
        if n_disc == 0:
            return None
        chi2 = (abs(fixes - breaks) - 1) ** 2 / n_disc
        p_value = math.erfc(math.sqrt(chi2 / 2.0))
        return {
            "test": "mcnemar_paired_directional_pooled",
            "subset": "genuine_signal_only",
            "types_pooled": len(rows),
            "n_scored": sum(r["n_scored"] for r in rows),
            "lstm_fixes": fixes,
            "lstm_breaks": breaks,
            "n_discordant": n_disc,
            "chi_square": round(float(chi2), 3),
            "p_value": float(f"{p_value:.4g}"),
            "significant_at_05": bool(p_value < 0.05 and fixes > breaks),
            "directional_pct_with_lstm": round(
                sum(r["directional_pct_with_lstm"] for r in rows) / len(rows), 1
            ),
            "directional_pct_reversion_only": round(
                sum(r["directional_pct_reversion_only"] for r in rows) / len(rows), 1
            ),
            "verdict": (
                "LSTM contributes a statistically significant directional improvement over the "
                "reversion coefficient alone; its effect on MAE is within run-to-run noise."
                if p_value < 0.05 and fixes > breaks
                else "LSTM shows no significant contribution over the reversion coefficient alone."
            ),
        }

    meta = {
        "version": 4,
        "targets": targets_meta,
        "trained_types": list(targets_meta.keys()),
        "seq_len": SEQ_LEN,
        "horizon": HORIZON,
        "delta_mode": DELTA_MODE,
        "seed": SEED,
        # Headline honest metrics, averaged across the trained types. `hit_rate_pct` states its
        # own threshold; `skill_vs_baseline_pct` is comparable across runs even when the test
        # window's volatility changes; `movement_ratio` says whether the model forecasts at all.
        "hit_rate_pct": {t: _avg_hit(t) for t in ("0.50", "1.00", "1.50", "2.00")},
        "skill_vs_baseline_pct": _avg("skill_vs_baseline_pct"),
        # Answers "does the LSTM in the title do anything?" — the one question MAE cannot settle,
        # because removing the network changes skill by less than run-to-run noise. See
        # _lstm_ablation for why this is measured on direction and on genuine-signal rows only.
        "lstm_ablation": _pooled_ablation(),
        "movement_ratio": (
            round(
                sum(
                    float((v.get("movement") or {}).get("ratio") or 0)
                    for v in targets_meta.values()
                )
                / len(targets_meta),
                4,
            )
            if targets_meta
            else None
        ),
        "last_date": str(df["Date"].iloc[-1].date()),
        "target": TARGET_COLUMN,
        "features": primary.get("features"),
        "backend": primary.get("backend"),
        "mae_peso": primary.get("mae_peso"),
        "rmse_peso": primary.get("rmse_peso"),
        "mape_pct": primary.get("mape_pct"),
        "r2": primary.get("r2"),
        "rolling_eval": primary.get("rolling_eval"),
        "accuracy_pct": avg_accuracy,
        "primary_accuracy_pct": primary.get("accuracy_pct"),
        "avg_accuracy_pct": avg_accuracy,
        "baseline_mae_peso": primary.get("baseline_mae_peso"),
        "baseline_rmse_peso": primary.get("baseline_rmse_peso"),
        "baseline_accuracy_pct": primary.get("baseline_accuracy_pct"),
        "beats_baseline": primary.get("beats_baseline"),
        "adf_pvalue": primary.get("adf_pvalue"),
        "train_samples": primary.get("train_samples"),
        "val_samples": primary.get("val_samples"),
        "test_samples": primary.get("test_samples"),
        "split_policy": primary.get("split_policy"),
        "split_dates": primary.get("split_dates"),
        "flat_pct_by_split": primary.get("flat_pct_by_split"),
    }
    _save_meta(meta)
    print("\n" + "=" * 47)
    print(f"[DONE] Trained {len(targets_meta)}/{len(train_list)} rice type(s)")
    print(f"[SAVED] Metadata -> {META_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)

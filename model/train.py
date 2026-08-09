# model/train.py — LSTM training for 2-day forecast (all rice types)
import json
import os
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
    pred = mlp.predict(X_test.reshape(X_test.shape[0], -1))
    return {
        "backend": "sklearn",
        "test_loss": float(np.mean((pred - y_test) ** 2)),
        "mae_peso": _mae_in_peso(y_test, pred, scaler, target_idx),
        "rmse_peso": _rmse_in_peso(y_test, pred, scaler, target_idx),
    }


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
            ModelCheckpoint(model_path, save_best_only=True, monitor="val_loss", verbose=0),
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

    loss, _ = model.evaluate(X_test, y_test, verbose=0)
    pred = model.predict(X_test, verbose=0)
    return {
        "backend": "tensorflow",
        "test_loss": float(loss),
        "mae_peso": _mae_in_peso(y_test, pred, scaler, target_idx),
        "rmse_peso": _rmse_in_peso(y_test, pred, scaler, target_idx),
    }


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

    # Chronological 70/15/15 split on sequences — no shuffle, no leakage.
    i_tr = int(n_seq * 0.70)
    i_va = int(n_seq * 0.85)
    if i_tr < 50 or (i_va - i_tr) < 5 or (n_seq - i_va) < 5:
        print(f"[SKIP] {target}: split too small (n_seq={n_seq}).")
        return None

    # Fit the scaler on TRAIN rows only, then transform everything (prevents val/test leakage).
    train_row_end = i_tr + SEQ_LEN
    scaler = MinMaxScaler().fit(raw[:train_row_end])
    scaled = scaler.transform(raw)
    X, y = make_sequences(scaled, target_idx, SEQ_LEN, HORIZON)

    X_train, y_train = X[:i_tr], y[:i_tr]
    X_val, y_val = X[i_tr:i_va], y[i_tr:i_va]
    X_test, y_test = X[i_va:], y[i_va:]
    split_policy = "chronological_70_15_15"

    keras_path, scaler_path, mlp_path = _model_paths(target)
    print(
        f"[INFO] {target}: train={len(X_train)} val={len(X_val)} test={len(X_test)} "
        f"n_features={len(features)}"
    )

    if use_tensorflow:
        metrics = _train_tensorflow(
            X_train,
            y_train,
            X_val,
            y_val,
            X_test,
            y_test,
            scaler,
            target_idx,
            len(features),
            keras_path,
            scaler_path,
            target_name=target,
        )
        print(f"[SAVED] {keras_path}")
    else:
        metrics = _train_sklearn(
            X_train, y_train, X_val, y_val, X_test, y_test, scaler, target_idx, mlp_path, scaler_path
        )
        print(f"[SAVED] {mlp_path}")

    baseline = _persistence_baseline(X_test, y_test, target_idx, scaler)
    adf_p = _adf_pvalue(sub[target].values)

    mean_price = float(sub[target].mean())
    accuracy = max(0.0, min(99.9, 100.0 - (metrics["mae_peso"] / max(mean_price, 1) * 100)))
    baseline_acc = max(0.0, min(99.9, 100.0 - (baseline["mae_peso"] / max(mean_price, 1) * 100)))
    return {
        "target": target,
        "features": features,
        "backend": metrics["backend"],
        "mae_peso": round(metrics["mae_peso"], 4),
        "rmse_peso": round(metrics["rmse_peso"], 4),
        "accuracy_pct": round(accuracy, 2),
        "baseline_mae_peso": round(baseline["mae_peso"], 4),
        "baseline_rmse_peso": round(baseline["rmse_peso"], 4),
        "baseline_accuracy_pct": round(baseline_acc, 2),
        "beats_baseline": bool(metrics["mae_peso"] < baseline["mae_peso"]),
        "adf_pvalue": (round(adf_p, 4) if adf_p is not None else None),
        "train_samples": len(X_train),
        "val_samples": len(X_val),
        "test_samples": len(X_test),
        "split_policy": split_policy,
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
            print(
                f"[DONE] {target} | MAE PHP {entry['mae_peso']:.4f} | "
                f"accuracy {entry['accuracy_pct']:.2f}%"
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

    meta = {
        "version": 3,
        "targets": targets_meta,
        "trained_types": list(targets_meta.keys()),
        "seq_len": SEQ_LEN,
        "horizon": HORIZON,
        "last_date": str(df["Date"].iloc[-1].date()),
        "target": TARGET_COLUMN,
        "features": primary.get("features"),
        "backend": primary.get("backend"),
        "mae_peso": primary.get("mae_peso"),
        "rmse_peso": primary.get("rmse_peso"),
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
    }
    _save_meta(meta)
    print("\n" + "=" * 47)
    print(f"[DONE] Trained {len(targets_meta)}/{len(train_list)} rice type(s)")
    print(f"[SAVED] Metadata -> {META_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)

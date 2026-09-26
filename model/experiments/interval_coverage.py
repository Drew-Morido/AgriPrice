"""
Walk-forward check of the published prediction interval's REALISED coverage.

For each of the last N_ORIGINS days, the interval is calibrated exactly as the live forecast does
(predict._conformal_half_widths on data up to that day, weekday-aware reversion included) and we
record whether each of the next HORIZON actual prices fell inside it. The nominal level is 0.93
because conformal under-covers on autocorrelated data; the target is ~90% realised.

Run:  cd model && py -3.13 experiments/interval_coverage.py
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import predict as P  # noqa: E402
from data_pipeline import HORIZON, SEQ_LEN, build_feature_frame, load_merged_frame  # noqa: E402
from mean_reversion import LSTM_DELTA_WEIGHT, rolling_phi  # noqa: E402

N_ORIGINS = int(os.environ.get("COVERAGE_ORIGINS", "120"))


def main():
    df = load_merged_frame()
    meta = P._load_meta() if hasattr(P, "_load_meta") else {}
    hits = {h: [] for h in range(HORIZON)}
    widths = {h: [] for h in range(HORIZON)}
    per_type = {}
    for target in ["locWellMilled", "locRegular", "locPremium", "locSpecial",
                   "impWellMilled", "impRegular", "impPremium", "impSpecial"]:
        keras_path, scaler_path, _ = P._resolve_paths(target)
        model, scaler = P._get_keras(keras_path), P._get_scaler(scaler_path)
        sub, features = build_feature_frame(df, target)
        ti = features.index(target)
        scaled = scaler.transform(sub[features].values.astype(float))
        ser = pd.to_numeric(sub[target], errors="coerce").values.astype(float)
        dows = P._row_weekdays(sub)
        scale = scaler.scale_[ti]
        t_hits = []
        n = len(scaled)
        for end in range(n - HORIZON - N_ORIGINS, n - HORIZON):
            hw = P._conformal_half_widths(model, scaled[:end + 1], ti, len(features), scaler, True,
                                          reversion={"applied": True}, series=ser[:end + 1], dows=dows[:end + 1])
            if not hw:
                continue
            win = scaled[end - SEQ_LEN + 1:end + 1].reshape(1, SEQ_LEN, len(features))
            pred = scaled[end, ti] + LSTM_DELTA_WEIGHT * np.asarray(model.predict(win, verbose=0)[0])
            phi, _ = rolling_phi(ser, end, HORIZON, dows=dows)
            pred = pred + phi[:, 0] * (ser[end] - ser[end - 1]) * scale
            pred_p = (pred - scaler.min_[ti]) / scale
            for h in range(HORIZON):
                ok = abs(ser[end + 1 + h] - pred_p[h]) <= hw[h]
                hits[h].append(ok); t_hits.append(ok); widths[h].append(2 * hw[h])
        per_type[target] = round(100 * np.mean(t_hits), 1)
        print(f"  {target:<14} realised {per_type[target]}%")
    print("\nrealised coverage by forecast day:",
          [round(100 * np.mean(hits[h]), 1) for h in range(HORIZON)],
          "| pooled", round(100 * np.mean(sum(hits.values(), [])), 1), "%")
    print("mean interval width (PHP) by day:", [round(float(np.mean(widths[h])), 3) for h in range(HORIZON)])


if __name__ == "__main__":
    main()

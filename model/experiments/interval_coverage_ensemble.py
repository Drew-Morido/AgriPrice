"""
Walk-forward check of the published price range's REALISED coverage for the adaptive ensemble.
For each of the last N_ORIGINS days, day-h's range half-width is the conformal quantile (nominal
CONFORMAL_COVERAGE) of the ensemble's previous CONFORMAL_WINDOW realised day-h errors — only errors already
observed on that day — and we count how often the real price landed inside. Target: ~90% realised.
Run:  cd model && py -3.13 experiments/interval_coverage_ensemble.py
"""
import os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.dirname(HERE))
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
import predict as P  # noqa: E402
from data_pipeline import HORIZON, RICE_COLUMNS, build_feature_frame, load_merged_frame  # noqa: E402

N_ORIGINS = 120
df = load_merged_frame()
meta = P._load_meta(); tm = P._targets_meta(meta)
hits = {h: [] for h in range(HORIZON)}; widths = {h: [] for h in range(HORIZON)}
for t in RICE_COLUMNS:
    kp, sp, mp = P._resolve_paths(t)
    model, scaler = P._get_keras(kp), P._get_scaler(sp)
    sub, feats = build_feature_frame(df, t)
    scaled = scaler.transform(sub[feats].values.astype(float))
    ens = P._ensemble_block(model, True, scaled, sub, t, scaler, feats.index(t), len(feats),
                            bool((tm.get(t, {}).get("reversion") or {}).get("applied")), extra_origins=N_ORIGINS)
    C, A = ens["combined"], ens["actual"]
    err = np.abs(A - C)
    n = len(C); th = []
    for k in range(n - N_ORIGINS - HORIZON, n - HORIZON):
        for h in range(HORIZON):
            cal = err[max(0, k - h - P.CONFORMAL_WINDOW):k - h, h]
            cal = cal[np.isfinite(cal)]
            if len(cal) < 20 or not np.isfinite(err[k, h]):
                continue
            q = np.sort(cal)[min(len(cal) - 1, int(np.ceil((len(cal) + 1) * P.CONFORMAL_COVERAGE)) - 1)]
            ok = err[k, h] <= q
            hits[h].append(ok); th.append(ok); widths[h].append(2 * q)
    print(f"  {t:<14} realised {100 * np.mean(th):.1f}%")
print("by forecast day:", [round(100 * np.mean(hits[h]), 1) for h in range(HORIZON)],
      "| pooled", round(100 * np.mean(sum(hits.values(), [])), 1), "%")
print("mean width (PHP):", [round(float(np.mean(widths[h])), 3) for h in range(HORIZON)])

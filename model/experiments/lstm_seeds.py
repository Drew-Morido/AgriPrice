"""
Stability check for V7 (fixed training, one network shared by the 8 rice types): does its test result
survive a change of random seed? Exploratory — V7's weight was not chosen on an untouched window, so
this decides only whether a prospective (shadow) evaluation is worth running, not whether to deploy.
Run:  cd model && py -3.13 experiments/lstm_seeds.py
"""
import json, os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.dirname(HERE))
import lstm_improve as L  # noqa: E402
import train as T  # noqa: E402

V7 = next(v for v in L.VARIANTS if v["name"] == "V7_fixed_pooled")
df = L.load_merged_frame()
out = {}
for seed in (7, 123, 2024):
    blocks, preds = L.run_variant(df, V7, seed=seed)
    res, cache = L.evaluate(blocks, preds)
    row = {k: {"sel": round(float(np.mean(v["sel"])), 2), "test": round(float(np.mean(v["test"])), 2),
               "test_min": min(v["test"]), "types_better_than_rev": None} for k, v in res.items()}
    rev = res["w0.0_rev"]["test"]
    for k, v in res.items():
        row[k]["types_better_than_rev"] = int(sum(a > b for a, b in zip(v["test"], rev)))
    row["ablation_w0.25"] = L.ablation(blocks, preds, cache, 0.25, True)
    out[seed] = row
    print(seed, {k: (row[k]["sel"], row[k]["test"], row[k]["types_better_than_rev"]) for k in ("w0.0_rev", "w0.25_rev", "w0.5_rev")},
          row["ablation_w0.25"], flush=True)
json.dump(out, open(os.path.join(HERE, "lstm_seeds_results.json"), "w"), indent=1)

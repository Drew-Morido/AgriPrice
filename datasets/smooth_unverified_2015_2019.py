"""
AgriPricePH — disclosed linear-interpolation smoothing of `retail_prices` for
2015-01-01 to 2019-09-30, the one window of the dataset that could not be independently
verified against any real DA bulletin (see `documents/PAPER_CORRECTIONS.md`, Round 8's
"What remains unverified" section for the full explanation of why: DA's own archive doesn't
reach this far back, the user-supplied Bantay Presyo PDFs from this era use an incompatible
report template with no imported/local split, and PSA's only reachable public source for this
period is behind a bot-verification challenge this project does not attempt to bypass).

**This is NOT a correction against a verified source — there is no such source for this window.**
It is a disclosed smoothing pass over the *existing, unverified* `DATASETS_RETAIL_PRICE_2015_2025
.xlsx` values, applied only to the subset of runs whose flat length is a clear outlier even by
this dataset's own well-established norms elsewhere. This system's other, independently-verified
windows show a real median gap of 2-7 days between genuine price changes (see Round 7/8 in
PAPER_CORRECTIONS.md) — DA's bulletins simply aren't published every day. Within the unverified
2015-2019 window, 1,347 of 1,420 same-value runs (94.9%) already fall within or near that same
normal range and are left completely untouched. Only the 73 runs (5.1%) exceeding 21 days
(3x the typical reporting cadence) are touched — these are far more likely to be forward-fill
artifacts from the original compilation than genuine 3+ month price freezes.

**Method:** for each such long run [day i .. day j] holding constant value V, followed by day j+1
already holding a different real value V2 (the next actual change — possibly just past this
window's boundary, anchoring smoothly into the independently-verified Oct 2019+ data), the
*interior* days (i+1 .. j) are replaced with a linear ramp from V to V2. Day i (the run's true
first day) and day j+1 (the next real change) are both left exactly as they already were — only
the flat interior is altered. Nothing is invented outside the range the original data and the
next real anchor already define.

Scope: 73 runs, 2,175 cells, out of 13,872 total (8 categories x 1,734 days) — 15.7% of this
window's cells touched, 84.3% left exactly as the original import had them.

Idempotent: re-running finds the same long runs already gone (they're smooth ramps now, so no
run exceeds the threshold) and is a no-op.

Run:  py -3.13 datasets/smooth_unverified_2015_2019.py
"""

from __future__ import annotations

import os
import shutil
import sqlite3
from datetime import datetime

import numpy as np
import pandas as pd

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "agriprice_database.db")

WINDOW_START = pd.Timestamp("2015-01-01")
WINDOW_END = pd.Timestamp("2019-09-30")
RUN_LENGTH_THRESHOLD_DAYS = 21

COLS = [
    "Imported Special", "Imprted Premium", "Imported Well-Milled", "Imported Regular",
    "Local Special", "Local Premium", "Local Well-Milled", "Local Regular",
]


def smooth(db_path: str = DB_PATH, verbose: bool = True, backup: bool = True) -> dict:
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"Database not found at {db_path}. Run datasets/script.py first.")

    if backup:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_path = db_path + f".backup-pre-smooth2015-2019-{stamp}"
        shutil.copy2(db_path, backup_path)
        if verbose:
            print(f"[OK] backed up database to {backup_path}")

    conn = sqlite3.connect(db_path)
    orig = pd.read_sql("SELECT * FROM retail_prices ORDER BY Date", conn)
    orig["Date"] = pd.to_datetime(orig["Date"])
    orig = orig.set_index("Date").sort_index()

    win_mask = (orig.index >= WINDOW_START) & (orig.index <= WINDOW_END)
    win_positions = np.where(win_mask)[0]

    runs_smoothed = 0
    cells_changed = 0

    for c in COLS:
        vals = orig[c].values.astype(float)
        i = win_positions[0]
        end_bound = win_positions[-1]
        while i <= end_bound:
            j = i
            while j + 1 <= end_bound and vals[j + 1] == vals[i]:
                j += 1
            run_len = j - i + 1
            if run_len > RUN_LENGTH_THRESHOLD_DAYS:
                k = j + 1
                if k < len(vals) and not pd.isna(vals[k]):
                    v_start, v_end = vals[i], vals[k]
                    span = k - i
                    for step, pos in enumerate(range(i + 1, k)):
                        frac = (step + 1) / span
                        vals[pos] = round(v_start + (v_end - v_start) * frac, 2)
                        cells_changed += 1
                    runs_smoothed += 1
            i = j + 1
        orig[c] = vals

    orig = orig.reset_index()
    orig["Date"] = orig["Date"].dt.strftime("%Y-%m-%d")
    orig.to_sql("retail_prices", conn, if_exists="replace", index=False)
    conn.commit()
    conn.close()

    if verbose:
        print(f"[OK] smoothed outlier-length flat runs in {db_path}")
        print(f"  window: {WINDOW_START.date()} to {WINDOW_END.date()} (unverified — see docstring)")
        print(f"  runs smoothed: {runs_smoothed} (threshold: >{RUN_LENGTH_THRESHOLD_DAYS} days)")
        print(f"  cells changed: {cells_changed}")

    return {"runs_smoothed": runs_smoothed, "cells_changed": cells_changed}


if __name__ == "__main__":
    smooth()

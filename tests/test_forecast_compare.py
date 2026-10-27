"""
Contract tests for Admin -> Forecast vs Actual (model/forecast_compare.py): the window and the error summaries
the page and the AVP quote.

Run:  py -3.13 -m pytest tests -q
"""

from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "model"))

import forecast_compare as fc  # noqa: E402

DAYS = [
    {"date": "2026-10-06", "actual": 49.0, "with_factors": 48.0, "without_factors": 48.0, "naive": 49.5},
    {"date": "2026-10-07", "actual": 49.0, "with_factors": 49.2, "without_factors": 49.1, "naive": 49.5},
    {"date": "2026-10-08", "actual": 50.0, "with_factors": 49.4, "without_factors": 49.5, "naive": 49.0},
]


def test_summary_is_mean_absolute_error_and_hit_rates():
    s = fc.summarise(DAYS[1:])
    assert s["with_factors"]["mae"] == 0.4                  # (0.2 + 0.6) / 2
    assert s["without_factors"]["mae"] == 0.3               # (0.1 + 0.5) / 2
    assert s["naive"]["mae"] == 0.75                        # (0.5 + 1.0) / 2
    assert s["with_factors"]["within_050_pct"] == 50.0 and s["with_factors"]["within_100_pct"] == 100.0
    assert s["with_factors"]["skill_vs_naive_pct"] == round((1 - 0.4 / 0.75) * 100, 1)
    assert s["mean_gap_with_vs_without"] == 0.1
    assert s["actual_range"] == 1.0


def test_default_window_starts_the_day_after_training_data_ends():
    cached = {"model_last_training_date": "2026-10-06", "types": {"locWellMilled": DAYS}}
    w = fc.window(cached, None, None)
    assert w["start"] == "2026-10-07" and w["end"] == "2026-10-08" and w["n_days"] == 2
    w = fc.window(cached, "2026-10-06", "2026-10-07")
    assert [d["date"] for d in w["types"]["locWellMilled"]["days"]] == ["2026-10-06", "2026-10-07"]

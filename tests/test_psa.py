"""
Tests for the PSA OpenSTAT source (tools/psa_openstat.py) and how its monthly figures enter the model.

The refresh guard keeps the stored copy when PSA returns something that looks incomplete or implausible,
and a month's figure is only used from the 15th of the following month (when PSA has published it), so
training never sees a stock or farmgate number before it existed.
"""

from __future__ import annotations

import os
import sys

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
sys.path.insert(0, os.path.join(ROOT, "model"))

import psa_openstat as psa  # noqa: E402


def _stocks(months=3, total=2_000_000.0):
    d = pd.date_range("2026-06-01", periods=months, freq="MS")
    return pd.DataFrame({"Date": d, "total": total, "household": 1.0, "commercial": 1.0, "nfa": 1.0})


def _farmgate(months=3, price=22.0):
    d = pd.date_range("2026-06-01", periods=months, freq="MS")
    return pd.DataFrame({"Date": d, "other_variety": price, "fancy": price})


def test_valid_refresh_passes():
    assert psa.validate(_stocks(), _farmgate(), {"PSA_rice_stocks": 3, "PSA_farmgate": 3}) == []


def test_refresh_that_would_shrink_the_table_is_refused():
    problems = psa.validate(_stocks(months=2), _farmgate(), {"PSA_rice_stocks": 3, "PSA_farmgate": 3})
    assert any("PSA_rice_stocks" in p and "partial" in p for p in problems)


def test_implausible_values_are_refused():
    assert psa.validate(_stocks(total=12.0), _farmgate(), {})           # tons mistaken for millions
    assert psa.validate(_stocks(), _farmgate(price=220.0), {})          # PHP/kg off by 10x


def test_month_figure_is_used_from_the_15th_of_the_next_month():
    import data_pipeline as dp

    aug = pd.Timestamp("2026-08-01")
    assert aug + dp.MONTHLY_RELEASE_LAG == pd.Timestamp("2026-09-15")

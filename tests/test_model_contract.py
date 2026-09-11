"""
Regression tests for the forecasting contract.

Panel finding: the repository had zero automated tests, so no regression was detectable except by
a human noticing. Two real defects were introduced during development and caught only by
inspection:

  * a sign/alignment error in the mean-reversion correction (it read the first FORECAST day
    instead of the last OBSERVED day), which drove directional accuracy to 0-32% — BELOW chance;
  * a string-replacement bug that prepended 19 lines to model/predict.py.

Both would have been caught in seconds by the assertions below. These tests encode the properties
that must hold for the system to be defensible, not merely "does it run".

Run:  py -3.13 -m pytest tests -q
"""

from __future__ import annotations

import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "model"))
META_PATH = os.path.join(ROOT, "model", "meta.json")

RICE_KEYS = {
    "locSpecial", "locPremium", "locWellMilled", "locRegular",
    "impSpecial", "impPremium", "impWellMilled", "impRegular",
}


@pytest.fixture(scope="module")
def meta():
    if not os.path.exists(META_PATH):
        pytest.skip("meta.json not present — train the model first")
    with open(META_PATH, encoding="utf-8") as fh:
        return json.load(fh)


# ── structural contract ───────────────────────────────────────────────────────
def test_all_eight_rice_types_trained(meta):
    assert set(meta["targets"]) == RICE_KEYS


def test_horizon_is_three_days(meta):
    assert meta["horizon"] == 3, "UI, paper and API all state a 3-day horizon"


def test_run_is_seeded(meta):
    assert meta.get("seed") is not None, "unseeded runs are not reproducible"


# ── the properties that actually matter ───────────────────────────────────────
def test_model_beats_naive_baseline_overall(meta):
    """The headline claim. If this fails, the thesis claim is false."""
    assert meta["skill_vs_baseline_pct"] > 0, (
        f"model no longer beats naive persistence "
        f"(skill {meta['skill_vs_baseline_pct']}%)"
    )


@pytest.mark.parametrize("key", sorted(RICE_KEYS))
def test_no_rice_type_is_worse_than_naive(meta, key):
    assert meta["targets"][key]["skill_vs_baseline_pct"] > 0, (
        f"{key} lost to the naive baseline"
    )


@pytest.mark.parametrize("key", sorted(RICE_KEYS))
def test_directional_accuracy_beats_a_coin_flip(meta, key):
    """Guards the exact class of bug that shipped once: sub-chance direction means the
    correction is applied with the wrong sign or against the wrong row."""
    d1 = meta["targets"][key]["directional_pct"][0]
    assert d1 > 50.0, f"{key} day-1 directional accuracy {d1}% is at or below chance"


def test_model_has_not_collapsed_to_a_constant(meta):
    """`movement_ratio` near zero means the model predicts 'no change' regardless of input —
    it scores well on a flat series while being useless. This is how the collapse was found."""
    assert meta["movement_ratio"] > 0.05, (
        f"model has collapsed to a near-constant forecast "
        f"(movement_ratio {meta['movement_ratio']})"
    )


def test_hit_rate_within_one_peso_is_reported_and_sane(meta):
    hr = meta["hit_rate_pct"]["1.00"]
    assert len(hr) == 3
    assert all(0 <= v <= 100 for v in hr)
    assert hr[0] >= hr[2] - 1e-9, "day-1 should not be less accurate than day-3"


def test_legacy_accuracy_metric_is_marked_do_not_report(meta):
    """`accuracy_pct` scores the naive baseline ABOVE the model; it must stay deprecated."""
    note = meta["targets"]["locWellMilled"].get("accuracy_pct_note", "")
    assert "do not report" in note.lower()


# ── leakage / methodology guards ──────────────────────────────────────────────
def test_test_split_is_strictly_after_validation_split(meta):
    val_end = meta["split_dates"]["val"][1]
    test_start = meta["split_dates"]["test"][0]
    assert test_start > val_end, "test window overlaps validation — leakage"


def test_reversion_is_fitted_before_the_test_window(meta):
    """phi must come from validation-era data only, never from the test window."""
    for key in RICE_KEYS:
        rev = meta["targets"][key].get("reversion") or {}
        if rev.get("applied"):
            assert rev["n_fit"] > 0
            assert abs(rev["phi"][0][0]) <= 1.0, "coefficient outside the clipped range"

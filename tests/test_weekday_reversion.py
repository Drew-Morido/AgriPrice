"""
Contract tests for the weekday-aware mean-reversion coefficient (model/mean_reversion.py).

What must hold for the result (+3.4% -> +7.8% skill) to be defensible:
  - no look-ahead: the coefficient served for a day depends only on rows before it;
  - it is reversion-only (never momentum) and bounded, like the global coefficient;
  - it picks up a weekday-specific effect when one exists, and falls back to the global value
    where a weekday shows none;
  - it can be switched off (AGRIPRICE_REVERSION_WEEKDAY=0) to reproduce the previous model.

Run:  py -3.13 -m pytest tests -q
"""

from __future__ import annotations

import importlib
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "model"))


def _series(n=400, seed=0):
    """Random walk plus a noisy Sunday that is undone on Monday."""
    rng = np.random.default_rng(seed)
    level = 50 + np.cumsum(rng.normal(0, 0.05, n))
    dows = np.arange(n) % 7
    noise = np.where(dows == 6, rng.normal(0, 0.8, n), rng.normal(0, 0.1, n))
    return level + noise, dows


def _mr(weekday="1"):
    os.environ["AGRIPRICE_REVERSION_WEEKDAY"] = weekday
    import mean_reversion
    return importlib.reload(mean_reversion)


def test_no_lookahead():
    mr = _mr()
    s, dows = _series()
    anchor = 300
    phi_a, _ = mr.rolling_phi(s, anchor, 3, dows=dows)
    s2 = s.copy()
    s2[anchor + 1:] += 25.0                      # change only the future
    phi_b, _ = mr.rolling_phi(s2, anchor, 3, dows=dows)
    assert np.allclose(phi_a, phi_b)


def test_reversion_only_and_bounded():
    mr = _mr()
    s, dows = _series()
    for anchor in range(150, 390, 7):
        phi, _ = mr.rolling_phi(s, anchor, 3, dows=dows)
        assert np.all(phi <= 0.0) and np.all(phi >= -1.0)


def test_sunday_gets_its_own_stronger_coefficient():
    mr = _mr()
    s, dows = _series()
    sunday = next(r for r in range(380, 300, -1) if dows[r] == 6)
    wednesday = next(r for r in range(380, 300, -1) if dows[r] == 2)
    phi_sun, rev_sun = mr.rolling_phi(s, sunday, 3, dows=dows)
    phi_wed, _ = mr.rolling_phi(s, wednesday, 3, dows=dows)
    assert rev_sun["weekday_mode"] and rev_sun["weekday"] == 6
    assert phi_sun[0, 0] < phi_wed[0, 0]         # more of a Sunday change is expected to reverse


def test_switch_off_restores_global_rule():
    s, dows = _series()
    mr_off = _mr("0")
    phi_off, rev_off = mr_off.rolling_phi(s, 350, 3, dows=dows)
    phi_global, _ = mr_off.rolling_phi(s, 350, 3)
    assert np.allclose(phi_off, phi_global) and "weekday_mode" not in rev_off
    _mr("1")                                     # leave the default on for other tests

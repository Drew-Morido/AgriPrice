"""
Automated price alerts (DA-AMAS feedback B2/B3) and calculated Market Drivers (D4).

  * Default rules exist for all 8 rice types, stay editable, and a deleted default is not re-created.
  * A rule fires once per DA bulletin day per rice type, not on every scrape.
  * The new conditions (move since the previous bulletin, tomorrow's forecast move) work.
  * Market Drivers are calculated per rice type, or labelled "not calculated" with a reason.

Run:  py -3.13 -m pytest tests -q
"""

from __future__ import annotations

import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "model"))

import alerts_engine as AE  # noqa: E402

PRICES = {"locWellMilled": 49.02, "locRegular": 45.56, "locPremium": 54.07, "locSpecial": 60.25,
          "impWellMilled": 48.63, "impRegular": 45.33, "impPremium": 55.72, "impSpecial": 60.70}


@pytest.fixture()
def engine(tmp_path, monkeypatch):
    monkeypatch.setattr(AE, "RULES_PATH", str(tmp_path / "rules.json"))
    monkeypatch.setattr(AE, "LOG_PATH", str(tmp_path / "log.json"))
    monkeypatch.setattr(AE, "STATE_PATH", str(tmp_path / "state.json"))
    AE._save_json(AE.RULES_PATH, [])        # no legacy rules: only the defaults
    state = {"ctx": None}

    def ctx(day="2026-10-27", prices=None, prev=None, tomorrow=None):
        prices = prices or PRICES
        prev = prev or prices
        state["ctx"] = {
            "current_prices": dict(prices),
            "history": {k: [prev[k], prices[k]] for k in prices},
            "forecast_day1": dict(tomorrow or prices),
            "forecast_confidence_min": None, "data_date": day, "ready": True,
        }
    ctx()
    monkeypatch.setattr(AE, "_build_context", lambda: state["ctx"])
    return ctx


def test_default_rules_cover_all_eight_types(engine):
    AE.evaluate_alerts()
    rules = {r["id"]: r for r in AE.list_rules()}
    for key, price in PRICES.items():
        above, below = rules[f"default-{key}-above"], rules[f"default-{key}-below"]
        assert above["default"] and below["default"]
        assert above["threshold"] > price > below["threshold"]
    assert "default-all-day-change" in rules and "default-all-forecast-move" in rules


def test_defaults_are_editable_and_a_deleted_one_stays_deleted(engine):
    AE.evaluate_alerts()
    assert AE.update_rule("default-locSpecial-above", {"threshold": 70.0})["threshold"] == 70.0
    assert AE.delete_rule("default-locRegular-below")
    AE.evaluate_alerts()
    ids = {r["id"] for r in AE.list_rules()}
    assert "default-locRegular-below" not in ids
    assert AE.create_rule({"name": "Mine", "rice_key": "impSpecial", "condition": "above", "threshold": 61})


def test_fires_once_per_bulletin_day(engine):
    AE.evaluate_alerts()
    AE.update_rule("default-locWellMilled-above", {"threshold": 40.0})    # 49.02 is above it
    first = AE.evaluate_alerts()["new_entries"]
    assert any(e["rule_id"] == "default-locWellMilled-above" for e in first)
    again = AE.evaluate_alerts()["new_entries"]                             # next scrape, same DA day
    assert not any(e["rule_id"] == "default-locWellMilled-above" for e in again)
    engine(day="2026-10-28")                                                # a new bulletin
    later = AE.evaluate_alerts()["new_entries"]
    assert any(e["rule_id"] == "default-locWellMilled-above" for e in later)


def test_move_and_forecast_conditions(engine):
    prev = dict(PRICES, locSpecial=58.90)                 # +1.35 since the previous bulletin
    tomorrow = dict(PRICES, impPremium=57.10)             # +1.38 expected tomorrow
    engine(prev=prev, tomorrow=tomorrow)
    new = AE.evaluate_alerts()["new_entries"]
    moved = [e for e in new if e["rule_id"] == "default-all-day-change"]
    fc = [e for e in new if e["rule_id"] == "default-all-forecast-move"]
    assert [e["rice_key"] for e in moved] == ["locSpecial"]
    assert [e["rice_key"] for e in fc] == ["impPremium"]


def test_unread_count_and_mark_read(engine):
    AE.evaluate_alerts()
    AE.update_rule("default-impSpecial-below", {"threshold": 99.0})
    AE.evaluate_alerts()
    assert AE.get_summary()["unread"] >= 1
    AE.mark_all_read()
    assert AE.get_summary()["unread"] == 0


def test_market_drivers_are_calculated_or_labelled():
    import market_drivers as MD
    for target in ("locWellMilled", "impRegular"):
        out = MD.compute(target)
        keys = [f["key"] for f in out["factors"]]
        assert keys == ["stock", "rainfall", "month", "tariff"]
        for f in out["factors"]:
            if f["status"] == "calculated":
                assert -1.0 <= f["r"] <= 1.0 and f["n"] >= MD.MIN_MONTHS and 0.0 <= f["p"] <= 1.0
            else:
                assert f["r"] is None and f["note"]
    tariff_local = MD.compute("locWellMilled")["factors"][3]
    assert tariff_local["status"] == "not_calculated" and "imported" in tariff_local["note"]
    js = open(os.path.join(ROOT, "admin", "js", "correlation.js"), encoding="utf-8").read()
    assert "r: -0.63" not in js and "r: 0.41" not in js        # no fixed numbers left in the page

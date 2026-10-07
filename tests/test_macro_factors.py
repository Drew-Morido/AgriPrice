"""
Contract tests for the monthly economic factors added on 2026-10-07 (PSA core inflation, World Bank Viet Nam 5% rice
price) and for the non-overlapping model input set.

Run:  py -3.13 -m pytest tests -q
"""

from __future__ import annotations

import os
import sys

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "model"))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import data_pipeline as dp  # noqa: E402
import macro_factors as mf  # noqa: E402
import worldbank_pinksheet as wb  # noqa: E402


def test_input_set_has_no_overlapping_columns():
    if dp.LEGACY_FEATURES:
        return
    assert {"core_inflation", "rice_world"} <= set(dp.FEATURE_COLUMNS)
    assert "fuel_ron95" not in dp.FEATURE_COLUMNS                     # r = 0.75 with diesel
    frame = pd.DataFrame({"Date": pd.date_range("2025-01-01", periods=40), "locWellMilled": 45.0,
                          **{c: 1.0 for c in dp.FEATURE_COLUMNS}})
    _, features = dp.add_engineered_features(frame, "locWellMilled")
    assert not [f for f in features if "_roll" in f or "_lag" in f]   # repeats of the 30-day window / of a driver


def test_a_monthly_figure_is_used_only_from_the_15th_of_the_next_month():
    assert pd.Timestamp("2025-08-01") + dp.MONTHLY_RELEASE_LAG == pd.Timestamp("2025-09-15")


def test_world_bank_sheet_is_read_by_column_name(tmp_path):
    rows = [["World Bank Commodity Price Data"], [], [], [],
            ["", "Crude oil", "Rice, Thai 5% ", "Rice, Viet Namese 5%"],
            ["", "($/bbl)", "($/mt)", "($/mt)"],
            ["2014M12", 60.0, 410.0, 360.0],
            ["2015M01", 47.0, 420.0, 374.4],
            ["2015M02", 50.0, 418.0, 370.0]]
    path = tmp_path / "pink.xlsx"
    pd.DataFrame(rows).to_excel(path, sheet_name="Monthly Prices", header=False, index=False)
    out = wb.parse_monthly(path.read_bytes(), from_year=2015)
    assert list(out["Date"].dt.strftime("%Y-%m")) == ["2015-01", "2015-02"]
    assert out["viet5"].tolist() == [374.4, 370.0] and out["thai5"].tolist() == [420.0, 418.0]


def test_refresh_is_refused_when_it_would_shrink_or_corrupt_the_series():
    months = pd.date_range("2015-01-01", periods=141, freq="MS")
    good = {"MACRO_core_inflation": pd.DataFrame({"Date": months, "core_cpi": 100.0, "core_inflation": 3.0}),
            "MACRO_world_rice": pd.DataFrame({"Date": months, "viet5": 400.0, "thai5": 450.0})}
    assert mf.validate(good, {"MACRO_core_inflation": 141, "MACRO_world_rice": 141}) == []
    short = {**good, "MACRO_world_rice": good["MACRO_world_rice"].iloc[:100]}
    assert any("partial" in p for p in mf.validate(short, {"MACRO_world_rice": 141}))
    wild = {**good, "MACRO_core_inflation": good["MACRO_core_inflation"].assign(core_inflation=45.0)}
    assert any("outside" in p for p in mf.validate(wild, {}))


def test_each_factor_is_its_own_scrape_step(monkeypatch):
    # Admin -> Data Sources / Web Scraper show core inflation and the world rice price as separate sources, each with
    # its own Fetch Now: refreshing one must not fetch the other.
    called = []
    monkeypatch.setitem(mf.FETCHERS, "MACRO_core_inflation", lambda: called.append("cpi") or pd.DataFrame())
    monkeypatch.setitem(mf.FETCHERS, "MACRO_world_rice", lambda: called.append("wb") or pd.DataFrame())
    assert list(mf.fetch(["MACRO_world_rice"])) == ["MACRO_world_rice"] and called == ["wb"]
    import scrap
    assert callable(scrap.fetch_core_inflation) and callable(scrap.fetch_world_rice)

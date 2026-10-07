"""
Contract tests for the 2015-2025 rice history rebuild (datasets/scripts/rebuild_verified_rice_history.py).

The point of the rebuild is that every rice price traces to a PSA or DA publication. These tests pin that down:
monthly PSA figures are held flat across their month (never interpolated), months PSA left blank repeat the last
published month, PSA only fills long gaps inside the DA era, DA's dated bulletins win over the weekly summaries, and the database holds exactly what the
rebuild produces (so nothing — e.g. the superseded smoothing script — has altered it since).

Run:  py -3.13 -m pytest tests -q
"""

from __future__ import annotations

import os
import sqlite3
import sys

import pandas as pd
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "datasets", "scripts"))

import rebuild_verified_rice_history as R  # noqa: E402


def _monthly(rows):
    return pd.DataFrame(rows, columns=["Date", "special", "premium", "well_milled", "regular"]).assign(
        Date=lambda d: pd.to_datetime(d["Date"]))


def test_psa_month_is_flat_and_blank_months_repeat_the_last_one(monkeypatch):
    monkeypatch.setattr(R, "START", pd.Timestamp("2015-01-01"))
    monkeypatch.setattr(R, "PSA_END", pd.Timestamp("2015-03-31"))
    prices, carried = R.psa_daily(_monthly([("2015-01-01", 52.0, 46.0, 43.0, 40.0),
                                            ("2015-03-01", 53.0, 47.0, 44.0, 41.0)]))   # February left blank
    assert (prices.loc["2015-01-01":"2015-01-31", "locWellMilled"] == 43.0).all()       # flat, not a ramp
    assert (prices.loc["2015-02-01":"2015-02-28", "locWellMilled"] == 43.0).all()       # repeats January
    assert carried.loc["2015-02-01":"2015-02-28"].all() and not carried.loc["2015-01-15"]
    assert (prices["locSpecial"] == prices["impSpecial"]).all()                         # PSA has no local/imported split


@pytest.fixture(scope="module")
def rebuilt():
    return R.build()


def test_every_day_2015_to_2025_has_an_official_price(rebuilt):
    prices, prov = rebuilt
    assert prices.index[0] == pd.Timestamp("2015-01-01") and prices.index[-1] == pd.Timestamp("2025-12-31")
    assert len(prices) == (prices.index[-1] - prices.index[0]).days + 1
    assert not prices.isna().any().any()
    assert prices.min().min() >= R.PRICE_BAND[0] and prices.max().max() <= R.PRICE_BAND[1]
    first_da = R.da_start()
    assert set(prov.loc[:first_da - pd.Timedelta(days=1), "source"]) == {"psa_openstat_monthly"}
    da_era = prov.loc[first_da:]
    # Inside the DA era PSA only ever fills a long gap (more than CARRY_DAYS without any DA figure).
    assert (da_era.loc[da_era["source"] == "psa_openstat_monthly", "psa_filled_cells"] > 0).all()
    assert set(da_era["source"]) <= {"da_daily_bulletin", "da_price_watch", "da_daily_price_index", "da_amas_weekly",
                                     "da_weekly_average_price", "psa_openstat_monthly"}


def test_dated_da_bulletin_wins_over_weekly_summary(rebuilt):
    prices, prov = rebuilt
    bantay = pd.read_csv(R.BANTAY_CSV).set_index("Date")
    assert prices.loc["2019-10-01", "locWellMilled"] == bantay.loc["2019-10-01", "locWellMilled"]
    bull = pd.read_csv(R.BULLETINS_CSV).set_index("Date")
    day = bull.index[bull["source"].str.contains("Daily Price Index")][0]
    assert prices.loc[day, "impSpecial"] == pytest.approx(bull.loc[day, "impSpecial"])
    assert prov.loc[day, "source"] == "da_daily_price_index"


def test_database_holds_exactly_the_rebuild(rebuilt):
    prices, _ = rebuilt
    con = sqlite3.connect(R.DB_PATH)
    try:
        db = pd.read_sql("SELECT * FROM retail_prices WHERE Date <= '2025-12-31'", con)
    finally:
        con.close()
    db["Date"] = pd.to_datetime(db["Date"])
    db = db.set_index("Date").rename(columns={v: k for k, v in R.DB_COLS.items()})[R.KEYS]
    diff = (db.reindex(prices.index) - prices).abs()
    assert diff.max().max() < 0.005, "retail_prices differs from the rebuild — re-run rebuild_verified_rice_history.py"

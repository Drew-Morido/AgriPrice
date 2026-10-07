"""
Contract tests for the DA daily-bulletin reader (datasets/scripts/parse_da_daily_bulletins.py).

DA changed its bulletin layout many times between 2018 and 2025. The reader must recognise each layout it supports,
take the PREVAILING price from the right column, and refuse — never guess — anything else (a range-only bulletin, an
image-only page, a row whose summary block was cut off). The text snippets below are copied from real bulletins.

Run:  py -3.13 -m pytest tests -q
"""

from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "datasets", "scripts"))

import parse_da_daily_bulletins as R  # noqa: E402

PAD = "\n" + "x" * 250   # real pages carry far more text than these snippets; the classifier needs >200 characters

PRICE_WATCH_2018 = """DAILY PRICE MONITORING REPORT
Market : Selected Wet Markets in Metro Manila
Date : March 23, 2018
Prevailing Price of Selected Agricultural Commodities
RICE
NFA(well milled) N/A 0 0 27 27 27 N/A 0 0 27 27 27 27.00
COMMERCIAL
Fancy 53 52 54 50 50 54 53 52 55 54 50 60 53.80
Premium 46 45 47 45 45 48 45 45 48 46 45 48 46.30
Well milled special rice 43 42 44 42 40 44 40 40 44 43 40 44 42.38
Regular milled ordinary rice 36 36 39 38 36 39 38 35 38 38 35 39 37.60
FISH""" + PAD

LAYOUT_A_2019 = """DAILY PRICE MONITORING
Date : October 7, 2019 (Monday)
Prevailing Low High Average
IMPORTED COMMERCIAL RICE
Special (Blue tag) kg 50.00 40.00 80.00 53.25
Premium (Yellow tag) kg 33.00 33.00 43.00 36.33
Well milled (White tag) kg 35.00 35.00 44.00 37.50
Regular milled (White tag) kg 32.00 32.00 40.00 34.67
LOCAL COMMERCIAL RICE
Special (Blue tag) kg 50.00 45.00 60.00 52.31
Premium (Yellow tag) kg 45.00 42.00 48.00 45.63
Well milled (White tag) kg 40.00 36.00 44.00 40.50
Regular milled (White tag) kg #N/A 30.00 39.00 35.78
FISH""" + PAD

TODAY_VS_YESTERDAY_2021 = """Prevailing Retail Prices of Selected Agri-fishery Commodities at NCR Markets
Legend: TODAY'S PREVAILING PRICE YESTERDAY'S PREVAILING PRICE
RICE September 01, 2021 August 31, 2021
IMPORTED COMMERCIAL RICE LOCAL COMMERCIAL RICE Milkfish Bangus 160.00 160.00
Special 52.00 52.00 Special 50.00 50.00 Tilapia 120.00 120.00
Premium 48.00 48.00 Premium 45.00 47.00 Local Round Scad 240.00 240.00
Well-milled 43.00 43.00 Well-milled 40.00 40.00 Imported Round NOT NOT
Regular Milled NOT NOT Regular Milled 38.00 38.00 Indian mackerel 300.00 260.00""" + PAD

RANGE_2023 = """Retail Price Range of Selected Agri-fishery Commodities at NCR Markets
Friday, July 7, 2023
IMPORTED COMMERCIAL RICE LOCAL COMMERCIAL RICE Milkfish Bangus 140.00 -240.00
Special 50.00 -58.00 Special 48.00 -60.00 Tilapia 105.00 -160.00""" + PAD


def test_price_watch_takes_the_ncr_prevailing_and_has_no_split():
    assert R.classify_page(PRICE_WATCH_2018) == "PW"
    row = R.read_pw(PRICE_WATCH_2018)
    # Fancy (= Special) ends "... 54 50 60 53.80": NCR-wide Prevailing 54, Low 50, High 60, Average 53.80.
    assert row["locSpecial"] == 54.0 and row["impSpecial"] == 54.0
    assert row["locPremium"] == 46.0 and row["locRegular"] == 38.0


def test_price_watch_row_without_its_summary_block_is_not_read():
    cut = PRICE_WATCH_2018.replace("Fancy 53 52 54 50 50 54 53 52 55 54 50 60 53.80", "Fancy 53 52 54 50 50 54 53 52 55")
    assert R.read_pw(cut)["locSpecial"] is None          # a market's figure is never passed off as the NCR figure


def test_layout_a_takes_the_first_value_and_leaves_na_empty():
    assert R.classify_page(LAYOUT_A_2019) == "SEC4"
    row = R.read_sec(LAYOUT_A_2019, 4)
    assert (row["impSpecial"], row["impPremium"], row["impWellMilled"]) == (50.0, 33.0, 35.0)
    assert row["locRegular"] is None                       # "#N/A" in the prevailing position
    assert R.check(row) is None                            # imported premium below well-milled is genuine DA data


def test_today_vs_yesterday_takes_today_and_handles_not():
    assert R.classify_page(TODAY_VS_YESTERDAY_2021) == "C"
    day, row = R.read_c(TODAY_VS_YESTERDAY_2021)
    assert day.isoformat() == "2021-09-01"
    assert row["impPremium"] == 48.0 and row["locPremium"] == 45.0      # today's value, not yesterday's 47.00
    assert row["impRegular"] is None and row["locRegular"] == 38.0


def test_range_only_and_image_pages_are_refused():
    assert R.classify_page(RANGE_2023) == "RANGE_ONLY"
    assert "RANGE_ONLY" in R.UNREAD and "NO_TEXT" in R.UNREAD
    assert R.classify_page("scanned image") == "NO_TEXT"


def test_check_rejects_impossible_rows():
    ok = {k: 45.0 for k in R.KEYS}
    assert R.check(ok) is None
    assert "outside" in R.check({**ok, "locSpecial": 4.5})
    assert "Regular" in R.check({**ok, "locRegular": 60.0})

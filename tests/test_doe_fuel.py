"""
Tests for the DOE fuel reader (tools/doe_fuel.py) and the fuel rules in model/data_pipeline.py.

Data finding (PAPER_CORRECTIONS.md, "Fuel source replaced with DOE"): the Zigwheels page froze at
RON95 PHP 58.15 / Diesel PHP 56.74 from 2026-05-28, and two pipeline guards erased the real March-May
2026 fuel spike as if it were a parse error. These tests pin the replacement: DOE's weekly NCR summary
is read exactly, a blank DOE cell is filled only from GasWatch PH's SAME week (and flagged), and DOE
rows are never second-guessed by the old plausibility band.

Fixtures are real DOE "Price Monitoring of Liquid Fuels — NCR" PDFs (tests/fixtures/doe_ncr_*.pdf).
"""

from __future__ import annotations

import os
import sys
from datetime import date

import pandas as pd
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
sys.path.insert(0, os.path.join(ROOT, "model"))
FIX = os.path.join(ROOT, "tests", "fixtures")

import doe_fuel  # noqa: E402

pytest.importorskip("pdfplumber")


def _read(name: str) -> bytes:
    with open(os.path.join(FIX, name), "rb") as f:
        return f.read()


def test_reads_current_doe_summary():
    w = doe_fuel.parse_ncr_summary(_read("doe_ncr_2026-09-22.pdf"))
    assert w["week_start"] == date(2026, 9, 22)
    assert (w["RON_95"], w["RON_91"], w["RON_97"]) == (96.20, 88.70, 98.20)
    assert (w["Diesel"], w["Diesel_Plus"], w["Kerosene"]) == (103.30, 107.90, 130.90)


def test_reads_older_period_of_template():
    # Dec 2024 bulletins say "for the period of" instead of "for the week of".
    w = doe_fuel.parse_ncr_summary(_read("doe_ncr_2024-12-03.pdf"))
    assert w["week_start"] == date(2024, 12, 3)
    assert w["RON_95"] == 61.65 and w["Diesel"] is not None


@pytest.mark.parametrize("label,expected", [
    ("September 22-28, 2026", date(2026, 9, 22)),
    ("December 30, 2025 - January 5, 2026", date(2025, 12, 30)),
    ("April 22-28,2025", date(2025, 4, 22)),
    ("January 27 - February 2, 2026", date(2026, 1, 27)),
])
def test_week_start(label, expected):
    assert doe_fuel._week_start(label) == expected


_GASWATCH_JS = '''
const PRICE_HISTORY = [
  {
    week: "2026-09-29",
    dieselAvg: 95.95,
    unleadedAvg: 89.55,
  },
  {
    week: "2026-09-22",
    dieselAvg: 103.52,
    unleadedAvg: 89.79,
  },
];
const GAS_STATIONS = [
  { "prices": { "diesel": 96.0, "premium95": 92.0, "kerosene": 126.0 } },
  { "prices": { "diesel": 95.0, "premium95": 94.0, "kerosene": 128.0 } },
];
'''


def test_parse_gaswatch_history_and_station_means():
    gw = doe_fuel.parse_gaswatch(_GASWATCH_JS)
    assert gw["current_week"] == date(2026, 9, 29)
    assert gw["history"][date(2026, 9, 22)] == {"Diesel": 103.52, "RON_91": 89.79}
    cur = gw["history"][date(2026, 9, 29)]
    assert cur["Diesel"] == 95.95            # weekly average wins over the station mean
    assert cur["RON_95"] == 93.0 and cur["Kerosene"] == 127.0


def test_blank_doe_cell_filled_from_same_gaswatch_week_only():
    gw = doe_fuel.parse_gaswatch(_GASWATCH_JS)
    weeks = [
        {"week_start": date(2026, 9, 22), "RON_95": 96.2, "Diesel": None, "RON_91": 88.7},
        {"week_start": date(2026, 9, 8), "RON_95": 85.7, "Diesel": None},   # GasWatch has no such week
    ]
    out = doe_fuel.fill_blanks_from_gaswatch(weeks, gw)
    assert out[0]["Diesel"] == 103.52 and out[0]["filled"] == ["Diesel"]
    assert out[0]["RON_95"] == 96.2           # DOE values are never overwritten
    assert out[1]["Diesel"] is None and "filled" not in out[1]
    assert doe_fuel.to_ws_fuel_row(out[0])["Filled"] == "Diesel"


def test_pipeline_guards_keep_real_doe_spike():
    import data_pipeline as dp

    ws = pd.DataFrame({
        "Date": ["04/07/2026", "09/22/2026", "10/02/2026"],
        "fuel_ron95": [96.5, 96.2, 58.15],
        "fuel_diesel": [153.7, 103.3, 56.74],
        "_parse_complete": [True, True, False],
    })
    out = dp._drop_implausible_fuel(dp._scrub_degenerate_fuel(ws.copy()))
    assert out.loc[0, "fuel_diesel"] == 153.7     # the April 2026 DOE figure is real and kept
    assert "_parse_complete" not in out.columns

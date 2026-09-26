"""
Contract tests for the forward-evaluation log (model/forecast_log.py).

The log is only evidence if (1) a forecast, once written, can never be changed afterwards, and (2) each row is
dated to the day the model actually forecasts (last data day + h), not the calendar day it was served.

Run:  py -3.13 -m pytest tests -q
"""

from __future__ import annotations

import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "model"))

import forecast_log as L  # noqa: E402


def _payload(price=45.2):
    return {
        "last_data_date": "2026-09-26",
        "current_prices": {"impRegular": 45.0},
        "forecasts_by_key": {"impRegular": [
            {"day": h, "price": price + h / 100, "low": 44.5, "high": 46.0, "direction": "steady", "model": "ensemble",
             "components": {"hybrid": 45.0, "arima": 45.1, "kalman": 45.05}} for h in (1, 2, 3)]},
    }


def test_rows_are_dated_to_the_forecast_day(tmp_path):
    db = str(tmp_path / "log.db")
    assert L.log_payload(_payload(), db) == 3
    rows = sqlite3.connect(db).execute("SELECT horizon, target_date, origin_price, comp_arima FROM forecast_log ORDER BY horizon").fetchall()
    assert [r[1] for r in rows] == ["2026-09-27", "2026-09-28", "2026-09-29"]
    assert all(r[2] == 45.0 and r[3] == 45.1 for r in rows)


def test_a_logged_forecast_is_never_overwritten(tmp_path):
    db = str(tmp_path / "log.db")
    L.log_payload(_payload(45.2), db)
    assert L.log_payload(_payload(99.0), db) == 0          # a later rebuild with different numbers
    first = sqlite3.connect(db).execute("SELECT forecast FROM forecast_log WHERE horizon = 1").fetchone()[0]
    assert abs(first - 45.21) < 1e-9


def test_empty_payload_logs_nothing(tmp_path):
    assert L.log_payload({"last_data_date": None}, str(tmp_path / "log.db")) == 0

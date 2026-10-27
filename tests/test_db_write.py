"""
Whole-table rewrites must never leave a table empty or missing for a reader.

The scraper used to rewrite WS_fuel with `to_sql(if_exists="replace")` (drop, create, insert). A forecast built
while that ran read no DOE fuel weeks, fell back to the 2015-2025 dataset ending Dec 2025, cut the data at
Jan 12, 2026 and served those prices. tools/db_write.replace_table swaps a side table in within one transaction.

Run:  py -3.13 -m pytest tests -q
"""

from __future__ import annotations

import os
import sqlite3
import sys
import threading

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import db_write  # noqa: E402


def test_reader_never_sees_an_empty_or_missing_table(tmp_path):
    db = str(tmp_path / "t.db")
    rows = pd.DataFrame({"Date": [f"d{i}" for i in range(400)], "v": range(400)})
    with sqlite3.connect(db) as c:
        rows.to_sql("WS_fuel", c, index=False)

    seen, errors, stop = [], [], threading.Event()

    def reader():
        conn = sqlite3.connect(db, timeout=30)
        while not stop.is_set():
            try:
                seen.append(conn.execute('SELECT COUNT(*) FROM "WS_fuel"').fetchone()[0])
            except sqlite3.OperationalError as exc:   # "no such table" = the bug
                errors.append(str(exc))
        conn.close()

    t = threading.Thread(target=reader)
    t.start()
    conn = sqlite3.connect(db, timeout=30)
    for _ in range(40):
        db_write.replace_table(conn, rows, "WS_fuel")
    conn.close()
    stop.set()
    t.join()

    assert not errors, errors[:3]
    assert seen and min(seen) == 400


def test_failed_swap_keeps_the_old_table(tmp_path):
    db = str(tmp_path / "t.db")
    conn = sqlite3.connect(db)
    pd.DataFrame({"a": [1, 2, 3]}).to_sql("keep", conn, index=False)
    conn.execute('CREATE VIEW "__swap_keep" AS SELECT 1')   # makes the side-table write fail
    try:
        db_write.replace_table(conn, pd.DataFrame({"a": [9]}), "keep")
    except Exception:
        pass
    assert conn.execute('SELECT COUNT(*) FROM "keep"').fetchone()[0] == 3
    conn.close()

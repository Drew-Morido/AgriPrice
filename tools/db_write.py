"""
Replace a whole SQLite table without ever leaving it empty for a reader.

`DataFrame.to_sql(name, conn, if_exists="replace")` drops the table, then creates it, then inserts the rows,
committing as it goes. Anything that reads the table in between (the forecast building its data frame while
the scraper writes) sees no rows. That is how a forecast once read "newest DOE fuel week: Dec 2025", cut the
data at Jan 12, 2026 and served those prices until the next rebuild.

`replace_table` writes the new rows into a side table first, then swaps it in with DROP + RENAME inside one
transaction. A reader sees either the complete old table or the complete new one; SQLite makes it wait (up
to its busy timeout) during the swap itself, which takes milliseconds.
"""

from __future__ import annotations

import sqlite3

import pandas as pd


def replace_table(conn: sqlite3.Connection, df: pd.DataFrame, name: str) -> None:
    side = f"__swap_{name}"
    conn.commit()                                    # close any implicit transaction first
    df.to_sql(side, conn, if_exists="replace", index=False)
    conn.commit()
    try:
        # Python's sqlite3 autocommits DDL unless a transaction is opened explicitly.
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(f'DROP TABLE IF EXISTS "{name}"')
        conn.execute(f'ALTER TABLE "{side}" RENAME TO "{name}"')
        conn.commit()
    except Exception:
        conn.rollback()
        conn.execute(f'DROP TABLE IF EXISTS "{side}"')
        conn.commit()
        raise


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None

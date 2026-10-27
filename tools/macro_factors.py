"""
AgriPricePH — the two monthly economic factors added on 2026-10-07 (asked for by the adviser), 2015 onward:

    core_inflation  PSA OpenSTAT, core CPI (excludes selected food and energy items, so it does not repeat the rice
                    price itself or the diesel price), year-on-year %  -> table MACRO_core_inflation
    rice_world      World Bank Pink Sheet, Rice Viet Namese 5% export price, USD/t -> table MACRO_world_rice

Each is its own scrape step (tools/scrap.fetch_core_inflation / fetch_world_rice -> refresh_one), with its own row in
Admin -> Data Sources and Web Scraper. Like the PSA stock/farmgate refresh, the whole series is replaced each time
(both sources revise past months) and a refresh that looks wrong — fewer months than stored, or a value outside a
plausible band — is refused and the stored copy kept. MACRO_meta records when each table was last refreshed.
"""

from __future__ import annotations

from datetime import datetime
from typing import Dict, List

import pandas as pd

from db_write import replace_table   # atomic table swap: readers never see a half-written table

import psa_openstat as psa
import worldbank_pinksheet as wb

TABLES = {"MACRO_core_inflation": ("core_inflation", (-5.0, 20.0), psa.SOURCE),
          "MACRO_world_rice": ("viet5", wb.BAND_USD_T, wb.SOURCE)}
FROM_YEAR = 2015


FETCHERS = {"MACRO_core_inflation": lambda: psa.fetch_core_inflation(FROM_YEAR),
            "MACRO_world_rice": lambda: wb.fetch_rice_prices(FROM_YEAR)}


def fetch(names=None) -> Dict[str, pd.DataFrame]:
    return {name: FETCHERS[name]() for name in (names or TABLES)}


def validate(frames: Dict[str, pd.DataFrame], existing_months: Dict[str, int]) -> List[str]:
    problems = []
    for name, df in frames.items():
        col, band, _ = TABLES[name]
        if df.empty:
            problems.append(f"{name}: source returned no rows")
            continue
        if len(df) < existing_months.get(name, 0):
            problems.append(f"{name}: {len(df)} months returned but {existing_months[name]} stored (partial response?)")
        if df["Date"].min() > pd.Timestamp(FROM_YEAR, 1, 1):
            problems.append(f"{name}: starts {df['Date'].min():%Y-%m}, not {FROM_YEAR}-01")
        bad = df[(df[col] < band[0]) | (df[col] > band[1])]
        if len(bad):
            problems.append(f"{name}: {len(bad)} value(s) of {col} outside {band}, e.g. {bad['Date'].iloc[0]:%Y-%m}")
    return problems


def write(conn, frames: Dict[str, pd.DataFrame]) -> None:
    for name, df in frames.items():
        out = df.copy()
        out["Date"] = out["Date"].dt.strftime("%Y-%m-%d")
        out["Source"] = TABLES[name][2]
        replace_table(conn, out, name)
        _stamp(conn, name, out)
    conn.commit()


def _stamp(conn, name: str, df: pd.DataFrame) -> None:
    conn.execute('CREATE TABLE IF NOT EXISTS "MACRO_meta" ("table" TEXT PRIMARY KEY, fetched_at TEXT, months INTEGER, '
                 'latest_month TEXT)')
    conn.execute('INSERT OR REPLACE INTO "MACRO_meta" VALUES (?, ?, ?, ?)',
                 (name, datetime.now().isoformat(timespec="seconds"), len(df), str(df["Date"].max())[:7]))


def stored_months(conn) -> Dict[str, int]:
    out = {}
    for name in TABLES:
        try:
            out[name] = conn.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
        except Exception:
            out[name] = 0
    return out


def refresh(conn, names=None) -> tuple[bool, List[str]]:
    """Fetch, check and store the factors (both, or only `names`). Returns (written, problems)."""
    frames = fetch(names)
    problems = validate(frames, stored_months(conn))
    if problems:
        return False, problems
    write(conn, frames)
    return True, []

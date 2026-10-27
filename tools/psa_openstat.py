"""
AgriPricePH — official PSA OpenSTAT data (Philippine Statistics Authority), via its public PXWeb JSON API.

    Rice stocks inventory  DB/2E/CS/0032E4ECNV0.px   "Rice and Corn: Monthly Total Stocks Inventory by Sector"
                           (metric tons; Total / Household / Commercial / NFA; monthly, 1980 onward)
    Palay farmgate price   DB/2M/NFG/0032M4AFN01.px  "Cereals: Farmgate Prices by Geolocation, Commodity, Year
                           and Period" (PHP/kg, dry, converted to 14% moisture; PHILIPPINES; monthly, 2010 onward)

These are the tables PhilRice Ricelytics cites as its source ("Source: Philippine Statistics Authority").
Only values PSA publishes are returned; a month PSA leaves blank ("..") comes back as None.
"""

from __future__ import annotations

import json
from typing import Dict, List, Optional

import pandas as pd
import requests

from db_write import replace_table   # atomic table swap: readers never see a half-written table

API = "https://openstat.psa.gov.ph/PXWeb/api/v1/en/DB"
STOCKS_TABLE = "2E/CS/0032E4ECNV0.px"
FARMGATE_TABLE = "2M/NFG/0032M4AFN01.px"
RETAIL_OLD_TABLE = "2M/RP/0042M4ARP01.px"   # "Cereals: Retail Prices of Agricultural Commodities" (Old Series, 1990-2021)
PHILIPPINES = "000000000"
SOURCE = "psa_openstat"

_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"}
_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
           "September", "October", "November", "December"]


def _json(resp: requests.Response):
    resp.raise_for_status()
    return json.loads(resp.content.decode("utf-8-sig"))   # PSA prefixes its JSON with a byte-order mark


def table_meta(table: str, timeout: int = 60) -> Dict:
    return _json(requests.get(f"{API}/{table}", headers=_HEADERS, timeout=timeout))


def _codes(meta: Dict, code: str) -> Dict[str, str]:
    """{value code -> label} for one variable of a table."""
    v = next(v for v in meta["variables"] if v["code"] == code)
    return dict(zip(v["values"], v["valueTexts"]))


def _query(table: str, selection: Dict[str, List[str]], timeout: int = 120) -> pd.DataFrame:
    body = {"query": [{"code": c, "selection": {"filter": "item", "values": v}} for c, v in selection.items()],
            "response": {"format": "json"}}
    d = _json(requests.post(f"{API}/{table}", headers=_HEADERS, json=body, timeout=timeout))
    dims = [c["code"] for c in d["columns"] if c.get("type") != "c"]
    rows = [dict(zip(dims, x["key"]), value=x["values"][0]) for x in d["data"]]
    df = pd.DataFrame(rows)
    df["value"] = pd.to_numeric(df["value"].replace({"..": None, "...": None, "-": None}), errors="coerce")
    return df


def _month_start(year_label: pd.Series, month_label: pd.Series) -> pd.Series:
    month = month_label.map({m: i + 1 for i, m in enumerate(_MONTHS)})
    return pd.to_datetime(dict(year=year_label.astype(int), month=month, day=1), errors="coerce")


def fetch_rice_stocks(from_year: int = 2015) -> pd.DataFrame:
    """Monthly national rice stocks inventory, metric tons: Date (month start), total, household, commercial, nfa."""
    meta = table_meta(STOCKS_TABLE)
    sectors, years, months = _codes(meta, "Sector"), _codes(meta, "Year"), _codes(meta, "Month")
    rice = {k: v for k, v in sectors.items() if v.startswith("Rice:")}
    df = _query(STOCKS_TABLE, {"Sector": list(rice),
                               "Year": [k for k, v in years.items() if int(v) >= from_year],
                               "Month": list(months)})
    df["Date"] = _month_start(df["Year"].map(years), df["Month"].map(months))
    df["col"] = df["Sector"].map(rice).map({"Rice: Total Stock": "total", "Rice: Household Stock": "household",
                                            "Rice: Commercial Stock": "commercial", "Rice: NFA Stock": "nfa"})
    out = df.pivot_table(index="Date", columns="col", values="value").reset_index()
    out = out.dropna(subset=["total"]).sort_values("Date").reset_index(drop=True)
    out.columns.name = None
    return out[["Date", "total", "household", "commercial", "nfa"]]


def fetch_palay_farmgate(from_year: int = 2015, geolocation: str = PHILIPPINES) -> pd.DataFrame:
    """Monthly palay farmgate price, PHP/kg: Date (month start), other_variety, fancy."""
    meta = table_meta(FARMGATE_TABLE)
    commodities, years, periods = _codes(meta, "Commodity"), _codes(meta, "Year"), _codes(meta, "Period")
    palay = {k: ("fancy" if "Fancy" in v else "other_variety") for k, v in commodities.items() if v.startswith("Palay")}
    df = _query(FARMGATE_TABLE, {"Geolocation": [geolocation], "Commodity": list(palay),
                                 "Year": [k for k, v in years.items() if int(v) >= from_year],
                                 "Period": [k for k, v in periods.items() if v in _MONTHS]})
    df["Date"] = _month_start(df["Year"].map(years), df["Period"].map(periods))
    df["col"] = df["Commodity"].map(palay)
    out = df.pivot_table(index="Date", columns="col", values="value").reset_index()
    out = out.dropna(subset=["other_variety", "fancy"], how="all").sort_values("Date").reset_index(drop=True)
    out.columns.name = None
    return out[["Date", "other_variety", "fancy"]]


def fetch_retail_rice_ncr(from_year: int = 2015) -> pd.DataFrame:
    """NCR monthly retail rice prices, PHP/kg, from PSA's OLD-series retail table (the only PSA retail table that
    reaches before 2018 with all four grades): Date (month start), special, premium, well_milled, regular.

    PSA publishes no local/imported split. Months PSA leaves blank come back as NaN."""
    meta = table_meta(RETAIL_OLD_TABLE)
    geos, commodities = _codes(meta, "Geolocation"), _codes(meta, "Commodity")
    years, periods = _codes(meta, "Year"), _codes(meta, "Period")
    ncr = [k for k, v in geos.items() if "NATIONAL CAPITAL REGION" in v.upper()]
    grade = {"Rice Special": "special", "Rice Premium": "premium",
             "Well Milled Rice (WMR)": "well_milled", "Regular Milled Rice (RMR)": "regular"}
    rice = {k: grade[v.strip()] for k, v in commodities.items() if v.strip() in grade}
    df = _query(RETAIL_OLD_TABLE, {"Geolocation": ncr[:1], "Commodity": list(rice),
                                   "Year": [k for k, v in years.items() if int(v) >= from_year],
                                   "Period": [k for k, v in periods.items() if v in _MONTHS]})
    df["Date"] = _month_start(df["Year"].map(years), df["Period"].map(periods))
    df["col"] = df["Commodity"].map(rice)
    out = df.pivot_table(index="Date", columns="col", values="value").reset_index()
    out = out.dropna(subset=list(grade.values()), how="all").sort_values("Date").reset_index(drop=True)
    out.columns.name = None
    return out[["Date", "special", "premium", "well_milled", "regular"]]


CORE_CPI_OLD_TABLE = "2M/PI/CPI/2018NEW/0012M4ACP33.px"   # Core CPI, all items, PH (2018=100), Jan 1994 - Dec 2017 (backcast)
CORE_CPI_TABLE = "2M/PI/CPI/2018NEW/0012M4ACP30.px"       # Core CPI by commodity group, PH (2018=100), Jan 2018 onward
_ABBR = [m[:3] for m in _MONTHS]


def fetch_core_inflation(from_year: int = 2015) -> pd.DataFrame:
    """Monthly national CORE inflation (CPI excluding selected food and energy items): Date (month start), core_cpi
    (index, 2018=100), core_inflation (year-on-year %, computed from the index).

    PSA's year-on-year core table starts in 2019, so the rate is computed from the index, which PSA publishes
    continuously on one base (2018=100): its backcast for 1994-2017 and its current table from 2018. Computed this
    way it equals PSA's own published rate on every month both exist (93 of 93, Jan 2019 - Sep 2026)."""
    first = from_year - 1                                     # a year earlier, for the first year-on-year rate
    old_meta = table_meta(CORE_CPI_OLD_TABLE)
    oy, op = _codes(old_meta, "Year"), _codes(old_meta, "Period")
    old = _query(CORE_CPI_OLD_TABLE, {"Year": [k for k, v in oy.items() if int(v) >= first],
                                      "Period": [k for k, v in op.items() if v in _MONTHS]})
    old["Date"] = _month_start(old["Year"].map(oy), old["Period"].map(op))
    new_meta = table_meta(CORE_CPI_TABLE)
    ng, nc = _codes(new_meta, "Geolocation"), _codes(new_meta, "Commodity Description")
    ny, np_ = _codes(new_meta, "Year"), _codes(new_meta, "Period")
    new = _query(CORE_CPI_TABLE, {"Geolocation": list(ng),
                                  "Commodity Description": [k for k, v in nc.items() if v.startswith("0 - ALL ITEMS")],
                                  "Year": list(ny), "Period": [k for k, v in np_.items() if v in _ABBR]})
    new["Date"] = _month_start(new["Year"].map(ny), new["Period"].map(np_).map(lambda a: _MONTHS[_ABBR.index(a)]))
    idx = (pd.concat([old[["Date", "value"]], new[["Date", "value"]]])
           .dropna().drop_duplicates("Date", keep="last").set_index("Date")["value"].sort_index())
    out = pd.DataFrame({"core_cpi": idx, "core_inflation": ((idx / idx.shift(12) - 1) * 100).round(2)})
    out = out[out.index >= pd.Timestamp(from_year, 1, 1)].dropna().reset_index()
    return out[["Date", "core_cpi", "core_inflation"]]


def latest_months(frame: Optional[pd.DataFrame]) -> Optional[str]:
    return None if frame is None or frame.empty else frame["Date"].max().strftime("%Y-%m")


def table_updated(table: str, timeout: int = 60) -> Optional[str]:
    """PSA's own 'last updated' timestamp for a table, from its folder listing."""
    folder, table_id = table.rsplit("/", 1)
    try:
        items = _json(requests.get(f"{API}/{folder}", headers=_HEADERS, timeout=timeout))
        return next((i.get("updated") for i in items if i.get("id") == table_id), None)
    except Exception:
        return None


# Sanity bands for a national monthly figure. Outside them the whole refresh is refused (keeps the last good copy).
STOCK_BAND_MT = (300_000, 8_000_000)
FARMGATE_BAND_PHP = (5.0, 80.0)


def validate(stocks: pd.DataFrame, farmgate: pd.DataFrame, existing_months: Dict[str, int]) -> List[str]:
    """Reasons to refuse a refresh (empty list = OK). `existing_months`: rows already stored per table."""
    problems = []
    for name, df, col, band in (("PSA_rice_stocks", stocks, "total", STOCK_BAND_MT),
                                ("PSA_farmgate", farmgate, "other_variety", FARMGATE_BAND_PHP)):
        if df.empty:
            problems.append(f"{name}: PSA returned no rows")
            continue
        if len(df) < existing_months.get(name, 0):
            problems.append(f"{name}: PSA returned {len(df)} months but {existing_months[name]} are stored "
                            "(partial response?)")
        bad = df[(df[col] < band[0]) | (df[col] > band[1])]
        if len(bad):
            problems.append(f"{name}: {len(bad)} value(s) of {col} outside {band}, e.g. "
                            f"{bad['Date'].iloc[0]:%Y-%m} = {bad[col].iloc[0]}")
    return problems


def write_tables(conn, stocks: pd.DataFrame, farmgate: pd.DataFrame) -> None:
    """Replace PSA_rice_stocks / PSA_farmgate (PSA revises past months, so a full refresh is right) and
    record PSA's table timestamps in PSA_meta."""
    for name, df in (("PSA_rice_stocks", stocks), ("PSA_farmgate", farmgate)):
        out = df.copy()
        out["Date"] = out["Date"].dt.strftime("%Y-%m-%d")
        out["Source"] = SOURCE
        replace_table(conn, out, name)
    replace_table(conn, pd.DataFrame([
        {"table": "PSA_rice_stocks", "psa_table": STOCKS_TABLE, "psa_updated": table_updated(STOCKS_TABLE),
         "latest_month": latest_months(stocks), "fetched_at": pd.Timestamp.now().isoformat(timespec="seconds")},
        {"table": "PSA_farmgate", "psa_table": FARMGATE_TABLE, "psa_updated": table_updated(FARMGATE_TABLE),
         "latest_month": latest_months(farmgate), "fetched_at": pd.Timestamp.now().isoformat(timespec="seconds")},
    ]), "PSA_meta")

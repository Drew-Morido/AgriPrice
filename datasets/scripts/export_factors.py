"""
AgriPricePH — write the final data of every factor out of the live database, 2015 to the latest day:

    datasets/1_factor_csv/<factor>.csv              one CSV per factor (what the model and the charts use)
    datasets/2_backup_database/by_factor/<factor>.db one SQLite copy per factor: the "final" table (same rows as the
                                                     CSV) plus the raw tables it was built from

    cd datasets/scripts && py -3.13 export_factors.py

Read-only on the live database. Runs automatically after every successful scrape (api/app.py::_export_factor_files),
so the folder always matches the database. Rice is built the way model/data_pipeline.py builds it: the verified
2015-2025 history (rice_price_provenance says which DA/PSA publication each day comes from) followed by the 2026 DA
bulletins, never a temporary "estimated" row; fuel switches from the 2015-2024 dataset to DOE at the first DOE week.
"""

from __future__ import annotations

import os
import sqlite3
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths  # noqa: E402

RICE = ["Local Special", "Local Premium", "Local Well-Milled", "Local Regular",
        "Imported Special", "Imported Premium", "Imported Well-Milled", "Imported Regular"]
WS_RICE = {"Local Well Milled": "Local Well-Milled", "Local Regular Milled": "Local Regular",
           "Imported Well Milled": "Imported Well-Milled", "Imported Regular Milled": "Imported Regular"}
TRUSTED_FUEL = ("doe_ncr_weekly", "gaswatchph")
START = pd.Timestamp("2015-01-01")

# factor -> (csv name, raw tables copied into its per-factor database)
FACTORS = {
    "rice_retail_prices": ("rice_retail_prices_daily.csv", ["retail_prices", "WS_rice_price", "rice_price_provenance"]),
    "fuel": ("fuel_ncr_weekly.csv", ["fuel_history", "WS_fuel"]),
    "exchange_rate": ("usd_php_daily.csv", ["usd_php_rates", "WS_currency"]),
    "rice_stocks": ("psa_rice_stocks_monthly.csv", ["PSA_rice_stocks", "PSA_meta"]),
    "farmgate": ("psa_farmgate_palay_monthly.csv", ["PSA_farmgate", "PSA_meta"]),
    "core_inflation": ("psa_core_inflation_monthly.csv", ["MACRO_core_inflation", "MACRO_meta"]),
    "world_rice": ("worldbank_rice_monthly.csv", ["MACRO_world_rice", "MACRO_meta"]),
}


def _dates(s: pd.Series) -> pd.Series:
    return pd.to_datetime(s, errors="coerce", format="mixed")


def _read(conn, table: str) -> pd.DataFrame:
    try:
        return pd.read_sql(f'SELECT * FROM "{table}"', conn)
    except Exception:
        return pd.DataFrame()


def rice(conn) -> pd.DataFrame:
    hist = _read(conn, "retail_prices").rename(columns={"Imprted Premium": "Imported Premium"})
    hist["Date"] = _dates(hist["Date"])
    prov = _read(conn, "rice_price_provenance")
    if not prov.empty:
        prov["Date"] = _dates(prov["Date"])
        hist = hist.merge(prov[["Date", "source", "frequency"]], on="Date", how="left")
    ws = _read(conn, "WS_rice_price").rename(columns=WS_RICE)
    if not ws.empty:
        ws["Date"] = _dates(ws["Date"])
        ws = ws[ws["Source"].fillna("da_official").str.lower() != "estimated"]
        ws = ws[ws["Date"] > hist["Date"].max()].rename(columns={"Source": "source"}).assign(frequency="daily")
        ws["source"] = ws["source"].fillna("da_official")
    out = pd.concat([hist, ws], ignore_index=True)
    return out[["Date", *RICE, "source", "frequency"]]


def fuel(conn) -> pd.DataFrame:
    hist = _read(conn, "fuel_history").rename(columns={" Gasoline RON 95": "RON 95", "Diesel": "Diesel"})
    hist = hist.assign(Date=_dates(hist["Date"]), source="fuel_history_dataset_2015_2025")[["Date", "RON 95", "Diesel", "source"]]
    ws = _read(conn, "WS_fuel")
    if not ws.empty:
        ws = ws[ws["Source"].isin(TRUSTED_FUEL)].assign(Date=lambda d: _dates(d["Date"]))
        ws = ws.rename(columns={"RON_95": "RON 95", "Source": "source"})
        cols = ["Date", "RON 95", "Diesel", "source"] + [c for c in ("RON_97", "RON_91", "Diesel_Plus", "Kerosene", "Filled")
                                                         if c in ws.columns]
        ws = ws[cols]
        if len(ws):
            hist = hist[hist["Date"] < ws["Date"].min()]
    return pd.concat([hist, ws], ignore_index=True)


def exchange(conn) -> pd.DataFrame:
    hist = _read(conn, "usd_php_rates").rename(columns={"USD to PHP": "USD_to_PHP"})
    hist = hist.assign(Date=_dates(hist["Date"]), source="usd_php_dataset")[["Date", "USD_to_PHP", "source"]]
    ws = _read(conn, "WS_currency")
    if not ws.empty:
        ws = ws.assign(Date=_dates(ws["Date"]), source=ws["Source"].fillna("open_er_api"))
        ws = ws[["Date", "USD_to_PHP", "THB_to_PHP", "VND_to_PHP", "source"]]
        hist = hist[~hist["Date"].isin(ws["Date"])]           # a scraped day replaces the dataset's copy
    return pd.concat([hist, ws], ignore_index=True)


def monthly(conn, table: str) -> pd.DataFrame:
    df = _read(conn, table)
    df["Date"] = _dates(df["Date"])
    return df.rename(columns={"Source": "source"})


BUILDERS = {
    "rice_retail_prices": rice, "fuel": fuel, "exchange_rate": exchange,
    "rice_stocks": lambda c: monthly(c, "PSA_rice_stocks"), "farmgate": lambda c: monthly(c, "PSA_farmgate"),
    "core_inflation": lambda c: monthly(c, "MACRO_core_inflation"), "world_rice": lambda c: monthly(c, "MACRO_world_rice"),
}


def export_all(db_path: str = paths.DB_PATH, verbose: bool = True) -> int:
    os.makedirs(paths.FACTOR_CSV_DIR, exist_ok=True)
    os.makedirs(paths.BY_FACTOR_DIR, exist_ok=True)
    written = 0
    conn = sqlite3.connect(db_path)
    try:
        for factor, (csv_name, raw_tables) in FACTORS.items():
            df = BUILDERS[factor](conn)
            df = df[df["Date"].notna() & (df["Date"] >= START)].sort_values("Date").drop_duplicates("Date", keep="last")
            out = df.assign(Date=df["Date"].dt.strftime("%Y-%m-%d"))
            out.to_csv(paths.factor_csv(csv_name), index=False)
            db_out = os.path.join(paths.BY_FACTOR_DIR, f"{factor}.db")
            tmp = db_out + ".tmp"
            if os.path.exists(tmp):
                os.remove(tmp)
            fconn = sqlite3.connect(tmp)
            try:
                out.to_sql("final", fconn, index=False)
                for t in raw_tables:
                    raw = _read(conn, t)
                    if not raw.empty:
                        raw.to_sql(t, fconn, index=False)
                fconn.commit()
            finally:
                fconn.close()            # sqlite3's context manager only commits; the file must be closed to move it
            os.replace(tmp, db_out)
            written += 2
            if verbose:
                print(f"{factor:20s} {len(out):5d} rows  {out['Date'].iloc[0]} .. {out['Date'].iloc[-1]}  -> 1_factor_csv/{csv_name}, "
                      f"by_factor/{factor}.db")
    finally:
        conn.close()
    return written


if __name__ == "__main__":
    export_all()

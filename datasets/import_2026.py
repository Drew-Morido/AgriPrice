"""
AgriPricePH — I-import ang 2026 daily XLSX files papunta sa agriprice_database.db.
Pagsamahin sa existing 2015-2025 data (hindi papalitan ang buong table).

Gamitin:
  py -3.13 datasets/import_2026.py
"""

from __future__ import annotations

import os
import sqlite3
from datetime import date

import pandas as pd

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "agriprice_database.db")

RICE_XLSX = os.path.join(BASE_DIR, "Rice_Daily_Prices_2026.xlsx")
FUEL_XLSX = os.path.join(BASE_DIR, "Fuel_2026_Daily.xlsx")
USD_XLSX = os.path.join(BASE_DIR, "USD_PHP_2026_Daily.xlsx")


def _parse_dates(series: pd.Series) -> pd.Series:
    return pd.to_datetime(series, errors="coerce", format="mixed")


def load_rice_2026() -> pd.DataFrame:
    raw = pd.read_excel(RICE_XLSX, sheet_name="Daily Rice Prices", header=None)
    # Row 0 = group headers, row 1 = Special/Premium/Well-Milled/Regular
    body = raw.iloc[2:].copy()
    body.columns = [
        "Date",
        "Imported Special",
        "Imported Premium",
        "Imported Well-Milled",
        "Imported Regular",
        "Local Special",
        "Local Premium",
        "Local Well-Milled",
        "Local Regular",
    ]
    body["Date"] = _parse_dates(body["Date"])
    for col in body.columns[1:]:
        body[col] = pd.to_numeric(body[col], errors="coerce")
    body = body.dropna(subset=["Date"]).sort_values("Date")
    # Fill missing price cells (hal. May 21-22 na walang value sa sheet)
    body = body.ffill()
    body["Imprted Premium"] = body["Imported Premium"]  # typo sa lumang DB schema
    return body[
        [
            "Date",
            "Imported Special",
            "Imprted Premium",
            "Imported Well-Milled",
            "Imported Regular",
            "Local Special",
            "Local Premium",
            "Local Well-Milled",
            "Local Regular",
        ]
    ]


def load_fuel_2026() -> pd.DataFrame:
    df = pd.read_excel(FUEL_XLSX, sheet_name="Daily Fuel Prices")
    out = pd.DataFrame({
        "Date": _parse_dates(df["Date"]),
        "Diesel": pd.to_numeric(df.iloc[:, 2], errors="coerce"),
    })
    out = out.dropna(subset=["Date"]).sort_values("Date")
    out = out.ffill()
    return out


def load_usd_2026() -> pd.DataFrame:
    df = pd.read_excel(USD_XLSX, sheet_name="Daily USD-PHP")
    out = pd.DataFrame({
        "Date": _parse_dates(df["Date"]),
        "USD to PHP": pd.to_numeric(df["USD to PHP"], errors="coerce"),
    })
    out = out.dropna(subset=["Date"]).sort_values("Date")
    out = out.ffill()
    return out


def _upsert_table(conn: sqlite3.Connection, table: str, new_df: pd.DataFrame) -> int:
    try:
        old = pd.read_sql(f'SELECT * FROM "{table}"', conn)
    except Exception:
        old = pd.DataFrame()

    if old.empty:
        merged = new_df
    else:
        old["Date"] = _parse_dates(old["Date"])
        merged = pd.concat([old, new_df], ignore_index=True)
        merged = merged.sort_values("Date")
        merged = merged.drop_duplicates(subset=["Date"], keep="last")

    merged.to_sql(table, conn, if_exists="replace", index=False)
    return len(new_df)


def import_all(verbose: bool = True) -> dict:
    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(
            f"Walang database sa {DB_PATH}. Patakbuhin muna: py -3.13 datasets/script.py"
        )

    stats = {}
    conn = sqlite3.connect(DB_PATH)

    if os.path.exists(RICE_XLSX):
        rice = load_rice_2026()
        stats["retail_prices"] = _upsert_table(conn, "retail_prices", rice)
        if verbose:
            print(f"retail_prices: +{stats['retail_prices']} rows from 2026 (latest {rice['Date'].iloc[-1].date()})")

    if os.path.exists(FUEL_XLSX):
        fuel = load_fuel_2026()
        # fuel_history may have extra columns — merge on Date only for Diesel
        try:
            old_fuel = pd.read_sql("SELECT * FROM fuel_history", conn)
            old_fuel["Date"] = _parse_dates(old_fuel["Date"])
            merged_f = pd.merge(
                old_fuel,
                fuel.rename(columns={"Diesel": "Diesel_new"}),
                on="Date",
                how="outer",
            )
            if "Diesel_new" in merged_f.columns:
                merged_f["Diesel"] = merged_f["Diesel_new"].combine_first(
                    merged_f.get("Diesel")
                )
                merged_f = merged_f.drop(columns=["Diesel_new"], errors="ignore")
            merged_f = merged_f.sort_values("Date").drop_duplicates(subset=["Date"], keep="last")
            merged_f.to_sql("fuel_history", conn, if_exists="replace", index=False)
            stats["fuel_history"] = len(fuel)
        except Exception:
            fuel.to_sql("fuel_history", conn, if_exists="append", index=False)
            stats["fuel_history"] = len(fuel)
        if verbose:
            print(f"fuel_history: updated with 2026 daily fuel")

    if os.path.exists(USD_XLSX):
        usd = load_usd_2026()
        stats["usd_php_rates"] = _upsert_table(conn, "usd_php_rates", usd)
        if verbose:
            print(f"usd_php_rates: +{stats['usd_php_rates']} rows (latest {usd['Date'].iloc[-1].date()})")

    conn.close()
    stats["ok"] = True
    stats["today"] = str(date.today())
    return stats


if __name__ == "__main__":
    print("Importing 2026 XLSX into", DB_PATH)
    result = import_all()
    print("Done.", result)

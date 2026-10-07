"""
AgriPricePH — rebuild the 2015-2025 rice price history (`retail_prices`) from official sources only.

Every value written comes from a PSA or DA publication; nothing from the original compiled
`DATASETS_RETAIL_PRICE_2015_2025.xlsx` survives. One row per day is kept so every chart keeps working.

    Jan 2015 - Sep 2018   PSA OpenSTAT "Cereals: Retail Prices of Agricultural Commodities" (Old Series,
                          2M/RP/0042M4ARP01), NCR, monthly: one figure per month on every day of that month; PSA has
                          no local/imported split, so Local X = Imported X.
    Oct 2018 - 2022       DA daily price bulletins (da_daily_bulletins.csv from parse_da_daily_bulletins.py; the
                          110 Bantay Presyo days are the same bulletins). Oct 2018 - Sep 2019 is DA's Price Watch, which
                          has no local/imported split either. The DA era starts at the first bulletin after the last
                          stretch of more than ERA_GAP_DAYS without one (DA posted none Apr - Sep 2018).
    2023 - Feb 2025       DA's daily bulletins give only a low-high RANGE, not a prevailing price, so these days use
                          DA's weekly prevailing prices: DA-AMAS weekly (NCR wet markets; 2024 sheet, and the 2025
                          sheet for Jan - Feb 2025 with week 1 = the week of Jan 1) and DA Weekly Average Price.
    Mar 2025 - Dec 2025   DA Daily Price Index.

Gaps, in this order: a daily DA figure is carried up to CARRY_DAYS (weekends, holidays, missing bulletins) — a
weekly figure never interrupts a daily run; beyond that DA's weekly prevailing price is used; a longer gap with no
weekly figure (Dec 2018, the 2020 lockdown, imported regular milled that DA often did not report in 2020) takes
PSA's figure for the month; only then is the last figure carried. The 2025 DA-AMAS sheet alignment cannot be
confirmed against bulletins (too flat: mean gap PHP 1.50 vs 1.52), so it is a disclosed, reasoned choice.

Provenance: table `rice_price_provenance` (one row per day: main source, published / carried / PSA-filled cells,
frequency). Monthly PSA snapshot: psa_retail_ncr_monthly.csv (read from PSA's API when missing, or --refresh-psa).
Idempotent. Backs up the database first.

Run:  cd datasets && py -3.13 rebuild_verified_rice_history.py [--refresh-psa] [--dry-run]
"""

from __future__ import annotations

import argparse
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths  # noqa: E402  (datasets/scripts/paths.py: every datasets/ location)
import shutil
import sqlite3
import sys
from datetime import datetime

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, paths.TOOLS_DIR)

DB_PATH = paths.DB_PATH
PSA_CSV = os.path.join(paths.PSA_API_DIR, "psa_retail_ncr_monthly.csv")
BULLETINS_CSV = paths.da_parsed("da_verified_retail_prices_2023-2025.csv")
BANTAY_CSV = paths.da_parsed("da_bantay_presyo_corrections_2019-2021.csv")
AMAS_CSV = paths.da_parsed("da_amas_weekly_corrections_2020-2023.csv")
DAILY_CSV = paths.da_parsed("da_daily_bulletins.csv")            # parse_da_daily_bulletins.py (2018 - Mar 2025)
CARRY_DAYS = 14   # a daily DA figure is carried over a gap up to this long before a weekly / PSA figure is used
ERA_GAP_DAYS = 31  # a longer stretch without any DA bulletin before 2020 pushes the start of the DA era past it

START, PSA_END, END = pd.Timestamp("2015-01-01"), pd.Timestamp("2019-09-30"), pd.Timestamp("2025-12-31")
KEYS = ["impSpecial", "impPremium", "impWellMilled", "impRegular",
        "locSpecial", "locPremium", "locWellMilled", "locRegular"]
DB_COLS = {"impSpecial": "Imported Special", "impPremium": "Imprted Premium",
           "impWellMilled": "Imported Well-Milled", "impRegular": "Imported Regular",
           "locSpecial": "Local Special", "locPremium": "Local Premium",
           "locWellMilled": "Local Well-Milled", "locRegular": "Local Regular"}
PSA_GRADE = {"Special": "special", "Premium": "premium", "WellMilled": "well_milled", "Regular": "regular"}
PRICE_BAND = (15.0, 150.0)


def psa_monthly(refresh: bool = False) -> pd.DataFrame:
    if refresh or not os.path.exists(PSA_CSV):
        import psa_openstat as psa
        df = psa.fetch_retail_rice_ncr(2015)
        df.assign(Date=df["Date"].dt.strftime("%Y-%m-%d"), Source="psa_openstat_old_series_ncr").to_csv(PSA_CSV, index=False)
    df = pd.read_csv(PSA_CSV, parse_dates=["Date"])
    return df


def psa_daily(monthly: pd.DataFrame, start: pd.Timestamp | None = None,
              end: pd.Timestamp | None = None) -> tuple[pd.DataFrame, pd.Series]:
    """One row per day, Jan 2015 - Sep 2019: each day takes its month's PSA figure (local = imported).

    PSA leaves a few months blank in this table (Nov-Dec 2015, May-Jun 2016); those repeat the last month PSA
    did publish. Returns (prices, carried) where `carried` marks the days of such months."""
    start, end = start or START, end or PSA_END
    days = pd.date_range(start, end)
    months = pd.period_range(start, end, freq="M")
    by_month = monthly.set_index(monthly["Date"].dt.to_period("M")).reindex(months)
    published = by_month[list(PSA_GRADE.values())].notna().all(axis=1)
    by_month = by_month.ffill()
    out = pd.DataFrame(index=days)
    for key in KEYS:
        grade = next(v for g, v in PSA_GRADE.items() if key.endswith(g))
        out[key] = by_month[grade].reindex(days.to_period("M")).values
    if out.isna().any().any():
        raise SystemExit("PSA has no figure for the first month(s) of 2015 - nothing written.")
    carried = pd.Series(~published.reindex(days.to_period("M")).values, index=days)
    return out, carried


def amas_weekly_2024_2025() -> pd.DataFrame:
    """DA-AMAS weekly workbook, 2024 (parser default) and 2025 (week 1 = the week of Jan 1), each week's value
    on its 7 days. Long frame: Date, key, value."""
    from parse_da_amas_weekly import parse_all
    frames = [parse_all(years=[2024])]
    w25 = parse_all(years=[2025], validate=False)
    w25["week_start"] = w25["week_start"] - pd.Timedelta(days=7)
    frames.append(w25)
    rows = []
    for w in frames:
        for r in w.itertuples():
            for d in pd.date_range(r.week_start, r.week_start + pd.Timedelta(days=6)):
                rows.append((d, r.key, r.value))
    out = pd.DataFrame(rows, columns=["Date", "key", "value"]).dropna()
    return out[(out["Date"] >= "2024-01-01") & (out["Date"] <= END)]


def _wide(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    df["Date"] = pd.to_datetime(df["Date"])
    return df.set_index("Date")[KEYS]


def _daily_bulletins() -> pd.DataFrame | None:
    if not os.path.exists(DAILY_CSV):
        return None
    return pd.read_csv(DAILY_CSV, parse_dates=["Date"]).set_index("Date")


def da_start() -> pd.Timestamp:
    """First day of the DA era: the first complete daily bulletin after the last stretch of more than ERA_GAP_DAYS with
    no bulletin (2018 has bulletins in Feb-Mar, none Apr-Sep, then Oct onward). Before it, PSA's monthly figure is used;
    switching back and forth between PSA and DA (different measures) would put artificial jumps in the series.
    Without the bulletins table, the first Bantay Presyo day (Oct 1, 2019)."""
    d = _daily_bulletins()
    if d is None:
        return PSA_END + pd.Timedelta(days=1)
    full = d.index[d[KEYS].notna().all(axis=1)].sort_values()
    early = full[full < pd.Timestamp("2020-01-01")]
    if not len(early):
        return PSA_END + pd.Timedelta(days=1)
    gaps = pd.Series(early[1:] - early[:-1], index=early[1:])
    long = gaps[gaps > pd.Timedelta(days=ERA_GAP_DAYS)]
    return long.index.max() if len(long) else early.min()


def da_layers(start: pd.Timestamp) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """(daily values, daily source, weekly values, weekly source) for the DA era. Within each, higher layers win."""
    days = pd.date_range(start, END)

    def empty():
        return pd.DataFrame(index=days, columns=KEYS, dtype=float), pd.DataFrame(index=days, columns=KEYS, dtype=object)

    def lay(val, src, frame, label):
        frame = frame.reindex(days)
        for key in KEYS:
            new = frame[key].notna()
            val.loc[new, key] = frame.loc[new, key]
            src.loc[new, key] = label if isinstance(label, str) else label[new]

    bull = pd.read_csv(BULLETINS_CSV)
    bull["Date"] = pd.to_datetime(bull["Date"])
    bull = bull.set_index("Date")
    is_dpi = bull["source"].str.contains("Daily Price Index")

    wv, ws = empty()                                                   # weekly prevailing figures (7 days each)
    amas = amas_weekly_2024_2025().pivot_table(index="Date", columns="key", values="value")
    lay(wv, ws, amas.reindex(columns=KEYS), "da_amas_weekly")
    lay(wv, ws, _wide(AMAS_CSV), "da_amas_weekly")
    lay(wv, ws, bull.loc[~is_dpi, KEYS], "da_weekly_average_price")

    dv, ds = empty()                                                   # dated daily DA figures
    lay(dv, ds, _wide(BANTAY_CSV), "da_daily_bulletin")
    daily = _daily_bulletins()
    if daily is not None:
        label = daily["template"].map(lambda t: "da_price_watch" if t in ("PW", "P19") else
                                      "da_daily_price_index" if t == "DPI" else "da_daily_bulletin")
        lay(dv, ds, daily[KEYS], label.reindex(days))
    lay(dv, ds, bull.loc[is_dpi, KEYS], "da_daily_price_index")
    return dv, ds, wv, ws


def build(refresh_psa: bool = False) -> tuple[pd.DataFrame, pd.DataFrame]:
    monthly = psa_monthly(refresh_psa)
    start = da_start()
    psa, psa_carried = psa_daily(monthly, START, start - pd.Timedelta(days=1))
    dv, ds, wv, ws = da_layers(start)
    first = dv.iloc[0].fillna(wv.iloc[0])
    if first.isna().any():
        raise SystemExit(f"No DA figure on {dv.index[0].date()} for {list(first[first.isna()].index)} - nothing written.")
    observed = dv.notna() | wv.notna()

    # 1) a daily DA figure is carried up to CARRY_DAYS (weekends, holidays, missing bulletins) — a weekly figure is NOT
    #    allowed to interrupt a daily run, or weekends would flip between two products;
    # 2) where no daily figure is that close, DA's weekly prevailing price is used;
    # 3) a gap longer than that with no weekly figure (2020 lockdown, unreported imported regular) takes PSA's figure
    #    for the month, where PSA published one; 4) only then is the last figure carried.
    val = dv.ffill(limit=CARRY_DAYS)
    src = ds.ffill(limit=CARRY_DAYS)
    use_w = val.isna() & wv.notna()
    val, src = val.mask(use_w, wv), src.mask(use_w, ws)
    psa_end = min(val.index[-1], monthly["Date"].max() + pd.offsets.MonthEnd(0))
    psa_fill = psa_daily(monthly, val.index[0], psa_end)[0].reindex(val.index)
    use_psa = val.isna() & psa_fill.notna()
    val, src = val.mask(use_psa, psa_fill), src.mask(use_psa, "psa_openstat_monthly")
    da, src = val.ffill(), src.ffill()
    prices = pd.concat([psa, da]).astype(float).round(2)

    prov = pd.DataFrame(index=prices.index)
    prov["source"] = ["psa_openstat_monthly"] * len(psa) + src.mode(axis=1)[0].tolist()
    # A PSA month counts as published on every one of its days (it is that month's figure), except months PSA left blank.
    prov["published_cells"] = (8 * (~psa_carried)).astype(int).tolist() + observed.sum(axis=1).tolist()
    prov["carried_cells"] = 8 - prov["published_cells"]
    prov["psa_filled_cells"] = [0] * len(psa) + use_psa.sum(axis=1).astype(int).tolist()
    freq = {"psa_openstat_monthly": "monthly", "da_amas_weekly": "weekly", "da_weekly_average_price": "weekly"}
    prov["frequency"] = prov["source"].map(freq).fillna("daily")

    lo, hi = PRICE_BAND
    bad = (prices < lo) | (prices > hi)
    if bad.any().any():
        d = prices.index[bad.any(axis=1)][0]
        raise SystemExit(f"Implausible price on {d.date()}: {prices.loc[d].to_dict()} - nothing written.")
    if prices.isna().any().any():
        raise SystemExit("Gaps remain after the rebuild - nothing written.")
    return prices, prov


def write(prices: pd.DataFrame, prov: pd.DataFrame, db_path: str = DB_PATH, backup: bool = True) -> None:
    if backup:
        b = paths.backup_path("pre-verified-rice")
        shutil.copy2(db_path, b)
        print(f"Backup: {os.path.basename(b)}")
    conn = sqlite3.connect(db_path)
    try:
        old = pd.read_sql("SELECT Date FROM retail_prices", conn)
        fmt = "%Y-%m-%d" if len(str(old["Date"].iloc[0])) == 10 else "%Y-%m-%d %H:%M:%S"
        out = prices.rename(columns=DB_COLS)[list(DB_COLS.values())]
        rows = [(*[float(x) for x in r[1:]], d.strftime(fmt)) for d, r in zip(out.index, out.itertuples())]
        sets = ", ".join(f'"{c}" = ?' for c in DB_COLS.values())
        conn.executemany(f'UPDATE retail_prices SET {sets} WHERE Date = ?', rows)
        missing = set(out.index.strftime(fmt)) - set(old["Date"].astype(str))
        if missing:
            cols = '", "'.join(DB_COLS.values())
            conn.executemany(f'INSERT INTO retail_prices ("Date", "{cols}") VALUES ({",".join("?" * 9)})',
                             [(r[-1], *r[:-1]) for r in rows if r[-1] in missing])
        p = prov.copy()
        p.insert(0, "Date", p.index.strftime("%Y-%m-%d"))
        p.to_sql("rice_price_provenance", conn, if_exists="replace", index=False)
        conn.commit()
    finally:
        conn.close()


def summary(prov: pd.DataFrame) -> pd.DataFrame:
    g = prov.groupby([prov.index.year, "source"]).size().unstack(fill_value=0)
    g["published_share_%"] = (prov.groupby(prov.index.year)["published_cells"].sum()
                              / (prov.groupby(prov.index.year).size() * 8) * 100).round(1)
    return g


def apply_corrections(verbose: bool = True, backup: bool = True, refresh_psa: bool = False) -> dict:
    """Hook for script.py (same name as the other correction scripts)."""
    prices, prov = build(refresh_psa)
    write(prices, prov, backup=backup)
    if verbose:
        print(summary(prov).to_string())
    return {"days": len(prices)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--refresh-psa", action="store_true", help="re-read PSA's API instead of the CSV snapshot")
    ap.add_argument("--dry-run", action="store_true", help="build and report, write nothing")
    a = ap.parse_args()
    prices, prov = build(a.refresh_psa)
    print(summary(prov).to_string())
    if a.dry_run:
        print("Dry run - nothing written.")
        return 0
    write(prices, prov)
    print(f"retail_prices rebuilt: {len(prices)} days, {prices.index[0].date()} .. {prices.index[-1].date()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

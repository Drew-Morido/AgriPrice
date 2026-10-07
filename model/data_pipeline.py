"""
AgriPricePH — shared dataset builder for training and inference.
Builds a unified daily frame with rice, fuel, stock, farmgate, and currency.
"""

from __future__ import annotations

import os
import sqlite3

import numpy as np
import pandas as pd

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(PROJECT_ROOT, "datasets", "agriprice_database.db")

# Exogenous drivers. Since 2026-10-07 the set has no overlapping inputs (measured on monthly changes: RON 95 vs
# diesel r = 0.75, each 7-day average vs its own series r = 0.98-0.99, and the target's lag/rolling columns repeat
# what the 30-day input window already holds) and adds two economic factors the adviser asked for:
#   core_inflation  PSA core CPI year-on-year %, which excludes food and energy so it repeats neither rice nor diesel
#   rice_world      World Bank Viet Nam 5% rice export price, USD/t (kept in dollars: USD/PHP is its own input)
# Fertilizer was considered and left out: it reaches retail rice through the palay farmgate price (already an input)
# and PSA has no monthly retail/dealer fertilizer price after 2019. AGRIPRICE_LEGACY_FEATURES=1 restores the
# previous 13-input set (RON 95, diesel and USD/PHP 7-day averages, target lag-1/lag-7/rolling-7) for comparison.
LEGACY_FEATURES = os.environ.get("AGRIPRICE_LEGACY_FEATURES", "0").strip().lower() in ("1", "true", "yes")
FEATURE_COLUMNS = (["fuel_ron95", "fuel_diesel", "stock", "farmgate", "exchange"] if LEGACY_FEATURES else
                   ["fuel_diesel", "stock", "farmgate", "exchange", "core_inflation", "rice_world"])
TARGET_COLUMN = "locWellMilled"
RICE_COLUMNS = [
    "locWellMilled",
    "locRegular",
    "locPremium",
    "locSpecial",
    "impWellMilled",
    "impRegular",
    "impPremium",
    "impSpecial",
]
# WS_rice_price (scraped DA bulletins) column -> internal key
WS_RICE_COLUMNS = {
    "Local Well Milled": "locWellMilled", "Local Premium": "locPremium",
    "Local Special": "locSpecial", "Local Regular Milled": "locRegular",
    "Imported Special": "impSpecial", "Imported Premium": "impPremium",
    "Imported Well Milled": "impWellMilled", "Imported Regular Milled": "impRegular",
}
SEQ_LEN = 30
HORIZON = 3

# ── Data readiness checklist ─────────────────────────────────────────────────────────────────
# A day enters the model only when every required source is verified for it; later days wait
# (the merged frame ends at the last ready day). Checked by evaluate_readiness().
READY_RICE_MIN_TYPES = 6        # DA official bulletin (never an estimate) with at least 6 of 8 types
READY_FUEL_MAX_AGE_DAYS = 14    # a weekly DOE/GasWatch fuel row dated at most 14 days before the day
READY_FX_MAX_AGE_DAYS = 4       # a USD/PHP rate at most 4 days old (weekends and holidays have none)
# Rice stock and farmgate are monthly series carried forward: reported, not blocking.
# A monthly figure (dated the 1st of its month) becomes usable on the 15th of the following month.
MONTHLY_RELEASE_LAG = pd.DateOffset(months=1, days=14)
LAST_READINESS: dict = {}

# Engineered-feature configuration (shared by training and inference so they never drift)
LAG_STEPS = (1, 7)          # target price lags (yesterday, one week back)
ROLL_WINDOW = 7             # rolling-average window in days
ROLL_DRIVERS = ("fuel_diesel", "exchange")  # exogenous drivers to smooth


def features_for_target(target: str) -> list:
    """Legacy raw feature list (rice + exogenous drivers), no engineered columns."""
    return [target, *FEATURE_COLUMNS]


def add_engineered_features(df: pd.DataFrame, target: str) -> tuple[pd.DataFrame, list]:
    """
    Add agricultural-seasonality, lag, and rolling-average features for a target.
    Returns (frame_with_features, ordered_feature_list). Deterministic — both
    train.py and predict.py call this so their feature matrices stay identical.
    """
    work = df.copy()

    # Agricultural seasonality: cyclical month encoding (lean vs. harvest cycle).
    dt = pd.to_datetime(work["Date"], errors="coerce")
    month = dt.dt.month.fillna(1).astype(float)
    work["season_sin"] = np.sin(2.0 * np.pi * month / 12.0)
    work["season_cos"] = np.cos(2.0 * np.pi * month / 12.0)

    if not LEGACY_FEATURES:
        work = work.bfill().ffill()
        features = [f for f in [target, *FEATURE_COLUMNS, "season_sin", "season_cos"] if f in work.columns]
        return work, features

    # Legacy set only: rolling averages of exogenous drivers and target lags.
    roll_cols = []
    for col in ROLL_DRIVERS:
        if col in work.columns:
            name = f"{col}_roll{ROLL_WINDOW}"
            work[name] = (
                pd.to_numeric(work[col], errors="coerce")
                .rolling(ROLL_WINDOW, min_periods=1)
                .mean()
            )
            roll_cols.append(name)

    # Target-specific lag + rolling features (temporal dependency the paper describes).
    t = pd.to_numeric(work[target], errors="coerce")
    lag_cols = []
    for k in LAG_STEPS:
        name = f"{target}_lag{k}"
        work[name] = t.shift(k)
        lag_cols.append(name)
    target_roll = f"{target}_roll{ROLL_WINDOW}"
    work[target_roll] = t.rolling(ROLL_WINDOW, min_periods=1).mean()

    # Fill the warm-up NaNs introduced by shift/rolling.
    work = work.bfill().ffill()

    features = [target, *FEATURE_COLUMNS, "season_sin", "season_cos", *roll_cols, *lag_cols, target_roll]
    features = [f for f in features if f in work.columns]
    return work, features


def build_feature_frame(df: pd.DataFrame, target: str) -> tuple[pd.DataFrame, list]:
    """Engineered frame filtered to rows with a positive target price."""
    work, features = add_engineered_features(df, target)
    vals = pd.to_numeric(work[target], errors="coerce")
    work = work[vals > 0].copy().reset_index(drop=True)
    return work, features


def frame_for_target(df: pd.DataFrame, target: str) -> pd.DataFrame:
    """Rows with a positive price for the given rice column."""
    if target not in df.columns:
        return df.iloc[0:0]
    vals = pd.to_numeric(df[target], errors="coerce")
    return df[vals > 0].copy()


def _parse_date_column(series: pd.Series) -> pd.Series:
    """Parse DB date strings without pandas format-inference warnings."""
    if series.empty:
        return series
    s = series.astype(str).str.strip()
    parsed = pd.to_datetime(s, format="%Y-%m-%d", errors="coerce")
    missing = parsed.isna()
    if missing.any():
        parsed.loc[missing] = pd.to_datetime(s[missing], format="%m/%d/%Y", errors="coerce")
    missing = parsed.isna()
    if missing.any():
        # pandas 2+ mixed format; older pandas falls back safely
        try:
            parsed.loc[missing] = pd.to_datetime(s[missing], format="mixed", errors="coerce")
        except (ValueError, TypeError):
            parsed.loc[missing] = pd.to_datetime(s[missing], errors="coerce")
    return parsed


def _db_path() -> str:
    api_db = os.path.join(PROJECT_ROOT, "api", "agriprice_database.db")
    if os.path.exists(DB_PATH):
        return DB_PATH
    if os.path.exists(api_db):
        return api_db
    return DB_PATH


# Plausible pump-price band for PH fuel, in PHP/litre. DOE's own NCR bulletins reach PHP 153.70
# (diesel, week of 2026-04-07), so the band must sit well above that. It used to be 15-110, set when the
# March-May 2026 fuel spike was wrongly taken for a scraper mis-parse; the DOE weekly PDFs show those
# prices were real (documents/PAPER_CORRECTIONS.md, "Fuel source replaced with DOE").
FUEL_PLAUSIBLE_MIN = 15.0
FUEL_PLAUSIBLE_MAX = 250.0
# WS_fuel rows carrying one of these sources were read from an official bulletin (or its documented
# fallback) and are never second-guessed by the legacy scrub below.
TRUSTED_FUEL_SOURCES = ("doe_ncr_weekly", "gaswatchph")


def _scrub_degenerate_fuel(df: pd.DataFrame) -> pd.DataFrame:
    """Legacy guard for old Zigwheels rows (no Source label) left in a database that has not been
    re-imported with datasets/scripts/import_doe_fuel.py. A partial parse (RON_100 / RON_91 / Diesel_Plus all
    NULL) outside the range of trustworthy rows (+/-20%) is blanked, so the merge-time ffill carries
    the last good reading instead. Rows from a trusted source are never touched.
    """
    complete = df.get("_parse_complete")
    if df.empty or "fuel_diesel" not in df.columns or complete is None:
        return df.drop(columns=["_parse_complete"], errors="ignore")
    complete = complete.astype(bool)
    trust = df[complete]
    if len(trust) >= 5:
        for col in ("fuel_ron95", "fuel_diesel"):
            if col not in df.columns:
                continue
            vals = pd.to_numeric(df[col], errors="coerce")
            good = pd.to_numeric(trust[col], errors="coerce").dropna()
            if good.empty:
                continue
            lo, hi = good.min() * 0.8, good.max() * 1.2
            suspect = (~complete) & (~vals.between(lo, hi))
            if suspect.any():
                print(f"[data_pipeline] fuel: blanked {int(suspect.sum())} degenerate-parse "
                      f"{col} value(s) outside PHP {lo:.2f}-{hi:.2f}")
            df[col] = vals.where(~suspect)
    return df.drop(columns=["_parse_complete"])


def _drop_implausible_fuel(df: pd.DataFrame) -> pd.DataFrame:
    """Blank fuel prices outside any realistic PH pump price (PHP 15-250), e.g. a unit or parse error.

    Out-of-band values are set to NaN (not dropped as rows) so the merge-time `ffill().bfill()` carries
    the last good reading forward. Nothing is invented and stored rows are untouched.
    """
    for col in ("fuel_ron95", "fuel_diesel"):
        if col not in df.columns:
            continue
        vals = pd.to_numeric(df[col], errors="coerce")
        df[col] = vals.where(vals.between(FUEL_PLAUSIBLE_MIN, FUEL_PLAUSIBLE_MAX))
    return df


def _latest_on_or_before(dates: pd.DatetimeIndex, day: pd.Timestamp):
    i = dates.searchsorted(day, side="right")
    return dates[i - 1] if i > 0 else None


def evaluate_readiness(rice_counts: pd.Series, fuel_dates, fx_dates, estimated_dates=(),
                       newest_day=None, stock_last=None, farmgate_last=None) -> dict:
    """The data checklist: which is the newest day whose inputs are ALL verified?

    rice_counts: official (non-estimated) DA rows per day -> number of rice types with a price.
    fuel_dates / fx_dates: days that have a fuel / USD-PHP value. estimated_dates: days that only have a
    temporary estimate. newest_day: the latest day any source reached (e.g. today's exchange rate).
    Returns {'ready_through', 'newest_day', 'ready_checks', 'held', 'rules'} (dates as ISO strings).
    """
    fuel_dates = pd.DatetimeIndex(sorted(pd.to_datetime(list(fuel_dates))))
    fx_dates = pd.DatetimeIndex(sorted(pd.to_datetime(list(fx_dates))))
    est = {pd.Timestamp(d).normalize() for d in estimated_dates}
    official = rice_counts.sort_index()
    iso = lambda d: pd.Timestamp(d).strftime("%Y-%m-%d")

    def checks(day):
        n = int(official.get(day, 0) or 0)
        f = _latest_on_or_before(fuel_dates, day)
        x = _latest_on_or_before(fx_dates, day)
        rice_detail = (f"{n} of 8 rice types from the DA bulletin" if n else
                       "only a temporary estimate — DA has not published this day" if day in est else
                       "no DA bulletin for this day")
        items = [
            {"id": "rice", "label": "DA rice bulletin (verified, not an estimate)", "blocking": True,
             "ok": n >= READY_RICE_MIN_TYPES, "detail": rice_detail},
            {"id": "fuel", "label": "Fuel prices (DOE weekly bulletin)", "blocking": True,
             "ok": f is not None and (day - f).days <= READY_FUEL_MAX_AGE_DAYS,
             "detail": f"week of {iso(f)} ({(day - f).days} days old)" if f is not None else "no fuel data"},
            {"id": "fx", "label": "USD/PHP exchange rate", "blocking": True,
             "ok": x is not None and (day - x).days <= READY_FX_MAX_AGE_DAYS,
             "detail": f"rate from {iso(x)}" if x is not None else "no exchange rate"},
        ]
        for key, label, last in (("stock", "Rice stock inventory (PSA, monthly)", stock_last),
                                 ("farmgate", "Palay farmgate price (PSA, monthly)", farmgate_last)):
            items.append({"id": key, "label": label, "blocking": False, "ok": last is not None,
                          "detail": (f"PSA {pd.Timestamp(last) - MONTHLY_RELEASE_LAG:%b %Y} figure, in use since {iso(last)}"
                                     if last is not None else "no data")})
        return items

    newest = pd.Timestamp(newest_day) if newest_day is not None else (official.index.max() if len(official) else None)
    held, ready = [], None
    # Every calendar day from the newest backwards until one passes; days with no DA row are held too.
    if newest is not None and len(official):
        day = newest.normalize()
        stop = official.index.min()
        while day >= stop:
            items = checks(day)
            if all(i["ok"] for i in items if i["blocking"]):
                ready = day
                break
            if len(held) < 14:
                held.append({"date": iso(day), "checks": items})
            day -= pd.Timedelta(days=1)
    return {
        "ready_through": iso(ready) if ready is not None else None,
        "newest_day": iso(newest) if newest is not None else None,
        "ready_checks": checks(ready) if ready is not None else [],
        "held": held,
        "rules": {"rice_min_types": READY_RICE_MIN_TYPES, "fuel_max_age_days": READY_FUEL_MAX_AGE_DAYS,
                  "fx_max_age_days": READY_FX_MAX_AGE_DAYS},
    }


def load_merged_frame() -> pd.DataFrame:
    """Load and merge all feature tables on Date."""
    db = _db_path()
    if not os.path.exists(db):
        raise FileNotFoundError(
            f"Database not found at {db}. Run: python datasets/scripts/script.py"
        )

    conn = sqlite3.connect(db)
    estimated_dates: list = []

    df_rice = pd.read_sql(
        """
        SELECT Date,
            "Local Well-Milled"    AS locWellMilled,
            "Local Premium"        AS locPremium,
            "Local Special"        AS locSpecial,
            "Local Regular"        AS locRegular,
            "Imported Special"     AS impSpecial,
            "Imprted Premium"      AS impPremium,
            "Imported Well-Milled" AS impWellMilled,
            "Imported Regular"     AS impRegular
        FROM retail_prices
        ORDER BY Date ASC
        """,
        conn,
    )

    try:
        df_rice_ws = pd.read_sql('SELECT * FROM "WS_rice_price" ORDER BY Date ASC', conn)
        # A temporary estimate (tools/rice_estimate.py, written when DA has not published yet) is never
        # model input: it used to enter here like a real bulletin — shown as "today's" price, used as the
        # forecast's starting point, and even scored as an "actual" in the test window.
        if "Source" in df_rice_ws.columns:
            is_est = df_rice_ws["Source"].fillna("da_official").str.lower() == "estimated"
            estimated_dates = _parse_date_column(df_rice_ws.loc[is_est, "Date"]).dropna().tolist()
            df_rice_ws = df_rice_ws[~is_est]
        df_rice_ws = df_rice_ws.rename(columns=WS_RICE_COLUMNS)
        df_rice_ws = df_rice_ws[["Date"] + [c for c in RICE_COLUMNS if c in df_rice_ws.columns]]
        df_rice = pd.concat([df_rice, df_rice_ws], ignore_index=True)
    except Exception:
        pass

    df_fuel = pd.read_sql(
        'SELECT Date, " Gasoline RON 95" AS fuel_ron95, Diesel AS fuel_diesel '
        'FROM fuel_history ORDER BY Date ASC',
        conn,
    )

    try:
        df_fuel_ws = pd.read_sql('SELECT * FROM "WS_fuel" ORDER BY Date ASC', conn)
        src = df_fuel_ws["Source"] if "Source" in df_fuel_ws.columns else pd.Series(None, index=df_fuel_ws.index)
        legacy = [c for c in ("RON_100", "RON_91", "Diesel_Plus") if c in df_fuel_ws.columns]
        # Trusted: an official-bulletin row (DOE, or its GasWatch fallback). Legacy unlabelled rows count
        # only when the old scraper captured all three secondary grades.
        df_fuel_ws["_parse_complete"] = src.isin(TRUSTED_FUEL_SOURCES) | (
            df_fuel_ws[legacy].notna().all(axis=1) if len(legacy) == 3 else False
        )
        df_fuel_ws = df_fuel_ws.rename(columns={"RON_95": "fuel_ron95", "Diesel": "fuel_diesel"})[
            ["Date", "fuel_ron95", "fuel_diesel", "_parse_complete"]]
        # From the first official DOE week on, DOE replaces the 2015-2025 dataset rather than being
        # averaged with it: through 2025 that dataset runs PHP 10-20 above DOE's NCR common price, and
        # two definitions on interleaved dates (dataset Mondays, DOE Tuesdays) would zig-zag the feature.
        doe_dates = pd.to_datetime(df_fuel_ws.loc[src.isin(TRUSTED_FUEL_SOURCES), "Date"], errors="coerce").dropna()
        if not doe_dates.empty:
            hist_dates = pd.to_datetime(df_fuel["Date"], errors="coerce")
            df_fuel = df_fuel[hist_dates < doe_dates.min()]
            # Likewise an unlabelled WS row dated inside the DOE era can only be a leftover from the
            # retired Zigwheels scraper (e.g. a server still running old code): it never overrides DOE.
            ws_dates = pd.to_datetime(df_fuel_ws["Date"], errors="coerce")
            df_fuel_ws = df_fuel_ws[src.isin(TRUSTED_FUEL_SOURCES) | (ws_dates < doe_dates.min())]
        df_fuel_ws = _scrub_degenerate_fuel(df_fuel_ws)
        df_fuel_ws = _drop_implausible_fuel(df_fuel_ws)
        df_fuel = pd.concat([df_fuel, df_fuel_ws], ignore_index=True)
    except Exception:
        pass

    df_usd = pd.read_sql(
        'SELECT Date, "USD to PHP" AS exchange FROM usd_php_rates ORDER BY Date ASC',
        conn,
    )
    try:
        df_usd_ws = pd.read_sql(
            'SELECT Date, USD_to_PHP AS exchange FROM "WS_currency" ORDER BY Date ASC',
            conn,
        )
        df_usd = pd.concat([df_usd, df_usd_ws], ignore_index=True)
    except Exception:
        pass

    # Rice stocks and palay farmgate: official PSA OpenSTAT monthly series (datasets/scripts/import_psa.py) when
    # present. The older rice_stock / farmgate_prices tables stopped at Dec 2025 and differ from PSA's
    # current figures; they are only the fallback for a database that has not been re-imported.
    try:
        df_stock = pd.read_sql('SELECT Date, total AS stock FROM "PSA_rice_stocks" ORDER BY Date ASC', conn)
    except Exception:
        df_stock = pd.DataFrame()
    if df_stock.empty:
        df_stock = pd.read_sql(
            'SELECT Date, "Rice Stock Inventory  Metric Ton" AS stock FROM rice_stock ORDER BY Date ASC',
            conn,
        )
    psa_farmgate = pd.DataFrame()
    try:
        psa_farmgate = pd.read_sql('SELECT Date, other_variety, fancy FROM "PSA_farmgate" ORDER BY Date ASC', conn)
    except Exception:
        pass
    try:
        df_farmgate = pd.read_sql(
            'SELECT Year, Month_Num, "Price_Ordinary (₱/kg)" AS farmgate_ordinary, '
            '"Price_Fancy (₱/kg)" AS farmgate_fancy FROM farmgate_prices',
            conn,
        ) if psa_farmgate.empty else pd.DataFrame()
    except Exception:
        df_farmgate = pd.DataFrame()

    # Monthly economic factors (tools/macro_factors.py): PSA core inflation and the World Bank Viet Nam 5% rice price.
    df_macro = []
    for table, cols in (("MACRO_core_inflation", "core_inflation"), ("MACRO_world_rice", "viet5 AS rice_world")):
        try:
            df_macro.append(pd.read_sql(f'SELECT Date, {cols} FROM "{table}" ORDER BY Date ASC', conn))
        except Exception:
            pass

    conn.close()

    if not psa_farmgate.empty:
        # Same definition as before: the mean of the two palay grades (PSA leaves "Fancy" blank in a few months,
        # where the mean is just "Other Variety").
        psa_farmgate["farmgate"] = psa_farmgate[["other_variety", "fancy"]].apply(
            pd.to_numeric, errors="coerce").mean(axis=1, skipna=True)
        df_farmgate = psa_farmgate[["Date", "farmgate"]].copy()
    elif not df_farmgate.empty:
        df_farmgate["Year"] = pd.to_numeric(df_farmgate.get("Year"), errors="coerce")
        df_farmgate["Month_Num"] = pd.to_numeric(df_farmgate.get("Month_Num"), errors="coerce")
        df_farmgate["farmgate_ordinary"] = pd.to_numeric(df_farmgate.get("farmgate_ordinary"), errors="coerce")
        df_farmgate["farmgate_fancy"] = pd.to_numeric(df_farmgate.get("farmgate_fancy"), errors="coerce")
        df_farmgate["farmgate"] = df_farmgate[["farmgate_ordinary", "farmgate_fancy"]].mean(axis=1, skipna=True)
        df_farmgate["Date"] = pd.to_datetime(
            dict(year=df_farmgate["Year"], month=df_farmgate["Month_Num"], day=1),
            errors="coerce",
        )
        df_farmgate = df_farmgate[["Date", "farmgate"]]

    for df in (df_rice, df_fuel, df_usd, df_stock, df_farmgate, *df_macro):
        if not df.empty and "Date" in df.columns:
            df["Date"] = _parse_date_column(df["Date"])

    # Monthly PSA figures enter on the day they could have been known, not on the first of their month:
    # PSA publishes month M around the 7th-15th of M+1 (e.g. Aug 2026 stocks on Sep 7, farmgate on Sep 14).
    # Dated on the 1st, training let early-August days use an August figure that did not exist yet.
    # The same lag covers core inflation (PSA releases month M around the 5th of M+1) and the World Bank Pink Sheet
    # (about the 2nd business day of M+1): both are known by the 15th of the following month.
    for df in (df_stock, df_farmgate, *df_macro):
        if not df.empty and "Date" in df.columns:
            df["Date"] = df["Date"] + MONTHLY_RELEASE_LAG

    df_rice = df_rice.dropna(subset=["Date"]).sort_values("Date")
    for col in (
        "locWellMilled", "locPremium", "locSpecial", "locRegular",
        "impSpecial", "impPremium", "impWellMilled", "impRegular",
    ):
        if col in df_rice.columns:
            df_rice[col] = pd.to_numeric(df_rice[col], errors="coerce")
    df_rice = df_rice.groupby("Date", as_index=False).mean(numeric_only=True)

    # Data readiness checklist: the frame ends at the newest day whose inputs are all verified.
    rice_cols = [c for c in RICE_COLUMNS if c in df_rice.columns]
    rice_counts = pd.Series((df_rice[rice_cols] > 0).sum(axis=1).values, index=pd.DatetimeIndex(df_rice["Date"]))
    fuel_dates = df_fuel.loc[df_fuel[["fuel_ron95", "fuel_diesel"]].notna().any(axis=1), "Date"].dropna()
    fx_dates = df_usd.loc[pd.to_numeric(df_usd["exchange"], errors="coerce").notna(), "Date"].dropna()
    reached = [s.max() for s in (df_rice["Date"], fuel_dates, fx_dates) if len(s)] + list(estimated_dates)
    newest = min(max(reached), pd.Timestamp.today().normalize()) if reached else None
    readiness = evaluate_readiness(
        rice_counts, fuel_dates, fx_dates, estimated_dates, newest,
        stock_last=df_stock["Date"].max() if not df_stock.empty else None,
        farmgate_last=df_farmgate["Date"].max() if not df_farmgate.empty else None,
    )
    LAST_READINESS.clear()
    LAST_READINESS.update(readiness)

    df = df_rice
    for extra in (df_fuel, df_usd, df_stock, df_farmgate, *df_macro):
        if extra is not None and not extra.empty:
            extra = extra.dropna(subset=["Date"]).sort_values("Date")
            extra = extra.groupby("Date", as_index=False).mean(numeric_only=True)
            df = pd.merge(df, extra, on="Date", how="outer")

    df = df.sort_values("Date").reset_index(drop=True)
    df = df.ffill().bfill()
    # Days after the last ready day wait: before this, a day with only (say) today's exchange rate
    # became a model row carrying yesterday's rice price forward, as if DA had reported "no change".
    if readiness["ready_through"]:
        df = df[df["Date"] <= pd.Timestamp(readiness["ready_through"])]

    for col in FEATURE_COLUMNS + [TARGET_COLUMN]:
        if col not in df.columns:
            if col in ("core_inflation", "rice_world"):
                print(f"[data_pipeline] {col} missing - run datasets/scripts/import_macro_factors.py (filled with 0)")
            df[col] = 0.0
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0.0)

    # Keep compatibility for any legacy consumers expecting "fuel".
    if "fuel" not in df.columns:
        ron = pd.to_numeric(df.get("fuel_ron95", 0.0), errors="coerce").fillna(0.0)
        df["fuel"] = (ron + df["fuel_diesel"]) / 2.0

    df = df.dropna(subset=[TARGET_COLUMN])
    df = df[df[TARGET_COLUMN] > 0]
    df = df[df["Date"] >= pd.Timestamp("2015-01-01")]

    return df


def make_sequences(scaled: np.ndarray, target_idx: int, seq_len: int, horizon: int):
    """Build (X, y) for multi-step forecasting."""
    X, y = [], []
    n = len(scaled)
    for i in range(n - seq_len - horizon + 1):
        X.append(scaled[i : i + seq_len])
        y.append(scaled[i + seq_len : i + seq_len + horizon, target_idx])
    return np.array(X), np.array(y)

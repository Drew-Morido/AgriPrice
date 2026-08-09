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

# Core exogenous driver set aligned with admin training spec
FEATURE_COLUMNS = [
    "fuel_ron95",
    "fuel_diesel",
    "stock",
    "farmgate",
    "exchange",
]
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
SEQ_LEN = 30
HORIZON = 3

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

    # Rolling averages of exogenous drivers (smooths transport/currency noise).
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


def load_merged_frame() -> pd.DataFrame:
    """Load and merge all feature tables on Date."""
    db = _db_path()
    if not os.path.exists(db):
        raise FileNotFoundError(
            f"Database not found at {db}. Run: python datasets/script.py"
        )

    conn = sqlite3.connect(db)

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
        df_rice_ws = pd.read_sql(
            """
            SELECT Date,
                "Local Well Milled"    AS locWellMilled,
                "Local Premium"        AS locPremium,
                "Local Special"        AS locSpecial,
                "Local Regular Milled" AS locRegular,
                "Imported Special"     AS impSpecial,
                "Imported Premium"     AS impPremium,
                "Imported Well Milled" AS impWellMilled,
                "Imported Regular Milled" AS impRegular
            FROM "WS_rice_price"
            ORDER BY Date ASC
            """,
            conn,
        )
        df_rice = pd.concat([df_rice, df_rice_ws], ignore_index=True)
    except Exception:
        pass

    df_fuel = pd.read_sql(
        'SELECT Date, " Gasoline RON 95" AS fuel_ron95, Diesel AS fuel_diesel '
        'FROM fuel_history ORDER BY Date ASC',
        conn,
    )
    try:
        df_fuel_ws = pd.read_sql(
            'SELECT Date, RON_95 AS fuel_ron95, Diesel AS fuel_diesel FROM "WS_fuel" ORDER BY Date ASC',
            conn,
        )
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

    df_stock = pd.read_sql(
        'SELECT Date, "Rice Stock Inventory  Metric Ton" AS stock FROM rice_stock ORDER BY Date ASC',
        conn,
    )
    try:
        df_farmgate = pd.read_sql(
            'SELECT Year, Month_Num, "Price_Ordinary (₱/kg)" AS farmgate_ordinary, '
            '"Price_Fancy (₱/kg)" AS farmgate_fancy FROM farmgate_prices',
            conn,
        )
    except Exception:
        df_farmgate = pd.DataFrame()

    conn.close()

    if not df_farmgate.empty:
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

    for df in (df_rice, df_fuel, df_usd, df_stock, df_farmgate):
        if not df.empty and "Date" in df.columns:
            df["Date"] = _parse_date_column(df["Date"])

    df_rice = df_rice.dropna(subset=["Date"]).sort_values("Date")
    for col in (
        "locWellMilled", "locPremium", "locSpecial", "locRegular",
        "impSpecial", "impPremium", "impWellMilled", "impRegular",
    ):
        if col in df_rice.columns:
            df_rice[col] = pd.to_numeric(df_rice[col], errors="coerce")
    df_rice = df_rice.groupby("Date", as_index=False).mean(numeric_only=True)

    df = df_rice
    for extra in (df_fuel, df_usd, df_stock, df_farmgate):
        if extra is not None and not extra.empty:
            extra = extra.dropna(subset=["Date"]).sort_values("Date")
            extra = extra.groupby("Date", as_index=False).mean(numeric_only=True)
            df = pd.merge(df, extra, on="Date", how="outer")

    df = df.sort_values("Date").reset_index(drop=True)
    df = df.ffill().bfill()

    for col in FEATURE_COLUMNS + [TARGET_COLUMN]:
        if col not in df.columns:
            df[col] = 0.0
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0.0)

    # Keep compatibility for any legacy consumers expecting "fuel".
    if "fuel" not in df.columns:
        df["fuel"] = (df["fuel_ron95"] + df["fuel_diesel"]) / 2.0

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

"""
AgriPricePH — server-side report generation and export history.
"""

from __future__ import annotations

import json
import os
import re
from datetime import date, datetime

import pandas as pd

API_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(API_DIR)
_DATASETS_DB = os.path.join(PROJECT_ROOT, "datasets", "agriprice_database.db")
_API_DB = os.path.join(API_DIR, "agriprice_database.db")
DB_PATH = _DATASETS_DB if os.path.exists(_DATASETS_DB) else _API_DB
MODEL_DIR = os.path.join(PROJECT_ROOT, "model")
META_PATH = os.path.join(MODEL_DIR, "meta.json")
REPORTS_DIR = os.path.join(PROJECT_ROOT, "documents", "reports")

SAFE_NAME = re.compile(r"^[a-zA-Z0-9._-]+$")


def ensure_reports_dir() -> str:
    os.makedirs(REPORTS_DIR, exist_ok=True)
    return REPORTS_DIR


def _format_size(num: int) -> str:
    if num < 1024:
        return f"{num} B"
    if num < 1024 * 1024:
        return f"{num / 1024:.1f} KB"
    return f"{num / (1024 * 1024):.1f} MB"


def _file_type(name: str) -> str:
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return {
        "csv": "csv",
        "json": "json",
        "xlsx": "xlsx",
        "html": "html",
        "pdf": "pdf",
    }.get(ext, "file")


def list_history() -> list[dict]:
    ensure_reports_dir()
    items = []
    for name in os.listdir(REPORTS_DIR):
        path = os.path.join(REPORTS_DIR, name)
        if not os.path.isfile(path):
            continue
        st = os.stat(path)
        created = datetime.fromtimestamp(st.st_mtime)
        items.append({
            "id": name,
            "filename": name,
            "type": _file_type(name),
            "size": st.st_size,
            "size_display": _format_size(st.st_size),
            "created_at": created.isoformat(timespec="seconds"),
            "created_display": created.strftime("%b %d, %Y · %I:%M %p"),
        })
    items.sort(key=lambda x: x["created_at"], reverse=True)
    return items


def _safe_path(filename: str) -> str | None:
    if not filename or not SAFE_NAME.match(filename):
        return None
    path = os.path.join(REPORTS_DIR, filename)
    if not os.path.abspath(path).startswith(os.path.abspath(REPORTS_DIR)):
        return None
    return path


def delete_file(filename: str) -> bool:
    path = _safe_path(filename)
    if not path or not os.path.isfile(path):
        return False
    os.remove(path)
    return True


def resolve_download(filename: str) -> str | None:
    path = _safe_path(filename)
    if path and os.path.isfile(path):
        return path
    return None


def _load_merged_prices_df() -> pd.DataFrame:
    import sqlite3

    conn = sqlite3.connect(DB_PATH)
    df_rice_hist = pd.read_sql(
        """
        SELECT Date,
            "Local Special" AS locSpecial,
            "Local Premium" AS locPremium,
            "Local Well-Milled" AS locWellMilled,
            "Local Regular" AS locRegular,
            "Imported Special" AS impSpecial,
            "Imprted Premium" AS impPremium,
            "Imported Well-Milled" AS impWellMilled,
            "Imported Regular" AS impRegular
        FROM retail_prices
        """,
        conn,
    )
    try:
        df_rice_ws = pd.read_sql(
            """
            SELECT Date,
                "Local Special" AS locSpecial,
                "Local Premium" AS locPremium,
                "Local Well Milled" AS locWellMilled,
                "Local Regular Milled" AS locRegular,
                "Imported Special" AS impSpecial,
                "Imported Premium" AS impPremium,
                "Imported Well Milled" AS impWellMilled,
                "Imported Regular Milled" AS impRegular
            FROM "WS_rice_price"
            """,
            conn,
        )
    except Exception:
        df_rice_ws = pd.DataFrame()

    df_fuel_hist = pd.read_sql("SELECT Date, Diesel AS fuel FROM fuel_history", conn)
    try:
        df_fuel_ws = pd.read_sql('SELECT Date, RON_95 AS fuel FROM "WS_fuel"', conn)
    except Exception:
        df_fuel_ws = pd.DataFrame()

    df_usd_hist = pd.read_sql(
        'SELECT Date, "USD to PHP" AS exchange FROM usd_php_rates', conn
    )
    try:
        df_usd_ws = pd.read_sql(
            'SELECT Date, USD_to_PHP AS exchange FROM "WS_currency"', conn
        )
    except Exception:
        df_usd_ws = pd.DataFrame()
    conn.close()

    df_rice = pd.concat([df_rice_hist, df_rice_ws], ignore_index=True)
    df_fuel = pd.concat([df_fuel_hist, df_fuel_ws], ignore_index=True)
    df_usd = pd.concat([df_usd_hist, df_usd_ws], ignore_index=True)

    for df in (df_rice, df_fuel, df_usd):
        if not df.empty:
            df["Date"] = pd.to_datetime(df["Date"], format="mixed")

    df_final = df_rice
    if not df_fuel.empty:
        df_final = pd.merge(df_final, df_fuel, on="Date", how="outer")
    if not df_usd.empty:
        df_final = pd.merge(df_final, df_usd, on="Date", how="outer")

    return df_final.sort_values("Date").reset_index(drop=True)


def generate_prices_csv() -> dict:
    ensure_reports_dir()
    df = _load_merged_prices_df()
    if df.empty:
        raise ValueError("No rice price data in database.")
    fname = f"rice_prices_{date.today().isoformat()}.csv"
    path = os.path.join(REPORTS_DIR, fname)
    out = df.copy()
    out["Date"] = pd.to_datetime(out["Date"]).dt.strftime("%Y-%m-%d")
    out.to_csv(path, index=False, encoding="utf-8-sig")
    return _file_meta(path, fname, "Price Report CSV")


def generate_metrics_json() -> dict:
    ensure_reports_dir()
    meta = {}
    if os.path.exists(META_PATH):
        with open(META_PATH, encoding="utf-8") as f:
            meta = json.load(f)

    live = {}
    if MODEL_DIR not in __import__("sys").path:
        import sys
        sys.path.insert(0, MODEL_DIR)
    try:
        from predict import predict

        pred = predict()
        if pred.get("ready"):
            live = {
                "forecast": pred.get("forecast"),
                "current_prices": pred.get("current_prices"),
                "as_of_date": pred.get("as_of_date"),
                "last_data_date": pred.get("last_data_date"),
            }
    except Exception as exc:
        live = {"error": str(exc)}

    payload = {
        "exported_at": datetime.now().isoformat(timespec="seconds"),
        "model_meta": meta,
        "live_prediction": live,
    }
    fname = f"model_metrics_{date.today().isoformat()}.json"
    path = os.path.join(REPORTS_DIR, fname)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    return _file_meta(path, fname, "Model Metrics")


def generate_correlation_xlsx() -> dict:
    ensure_reports_dir()
    df = _load_merged_prices_df()
    cols = [
        "locWellMilled", "locRegular", "locPremium", "locSpecial",
        "impWellMilled", "impRegular", "impPremium", "impSpecial",
        "fuel", "exchange",
    ]
    present = [c for c in cols if c in df.columns]
    if len(present) < 2:
        raise ValueError("Not enough series for correlation matrix.")

    numeric = df[present].apply(pd.to_numeric, errors="coerce")
    corr = numeric.corr().round(4)
    labels = {
        "locWellMilled": "Local Well-Milled",
        "locRegular": "Local Regular",
        "locPremium": "Local Premium",
        "locSpecial": "Local Special",
        "impWellMilled": "Imported Well-Milled",
        "impRegular": "Imported Regular",
        "impPremium": "Imported Premium",
        "impSpecial": "Imported Special",
        "fuel": "Diesel Fuel",
        "exchange": "USD/PHP",
    }
    corr.index = [labels.get(i, i) for i in corr.index]
    corr.columns = [labels.get(c, c) for c in corr.columns]

    fname = f"correlation_matrix_{date.today().isoformat()}.xlsx"
    path = os.path.join(REPORTS_DIR, fname)
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        corr.to_excel(writer, sheet_name="Pearson r")
        numeric.describe().to_excel(writer, sheet_name="Summary Stats")
    return _file_meta(path, fname, "Correlation Data")


def generate_forecast_html() -> dict:
    ensure_reports_dir()
    if MODEL_DIR not in __import__("sys").path:
        import sys
        sys.path.insert(0, MODEL_DIR)
    from predict import predict

    pred = predict()
    if pred.get("error"):
        raise ValueError(pred["error"])

    rows = pred.get("forecast") or []
    metrics = pred.get("metrics") or {}
    as_of = pred.get("as_of_display") or date.today().strftime("%B %d, %Y")
    rice = pred.get("rice_type", "Local Well-Milled")
    last_p = pred.get("last_price", "—")

    table_rows = "".join(
        f"<tr><td>Day {f.get('day', '')}</td><td>{f.get('date', '')}</td>"
        f"<td>₱{float(f.get('price', 0)):.2f}</td>"
        f"<td>{float(f.get('change', 0)):+.2f}</td>"
        f"<td>{float(f.get('confidence', 0)) * 100:.0f}%</td></tr>"
        for f in rows
    )

    html = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<title>AgriPricePH Forecast Report</title>
<style>
  body {{ font-family: Segoe UI, Arial, sans-serif; margin: 32px; color: #1a2e1f; }}
  h1 {{ color: #2D8A50; font-size: 22px; }}
  .meta {{ font-size: 13px; color: #555; margin-bottom: 20px; }}
  table {{ border-collapse: collapse; width: 100%; max-width: 640px; }}
  th, td {{ border: 1px solid #ddd; padding: 8px 12px; text-align: left; }}
  th {{ background: #e8f5ec; }}
  @media print {{ body {{ margin: 16px; }} }}
</style></head><body>
<h1>AgriPricePH — 2-Day LSTM Forecast</h1>
<p class="meta">Rice type: <strong>{rice}</strong> · Last price: <strong>₱{last_p}</strong> · As of: {as_of}</p>
<p class="meta">MAE: ₱{metrics.get('mae_peso', '—')} · RMSE: ₱{metrics.get('rmse_peso', '—')} · Accuracy: {metrics.get('accuracy_pct', '—')}%</p>
<table>
  <thead><tr><th>Day</th><th>Date</th><th>Forecast (₱)</th><th>Change</th><th>Confidence</th></tr></thead>
  <tbody>{table_rows}</tbody>
</table>
<p class="meta" style="margin-top:24px;">Generated {datetime.now().strftime("%Y-%m-%d %H:%M")} — AgriPricePH</p>
</body></html>"""

    fname = f"forecast_report_{date.today().isoformat()}.html"
    path = os.path.join(REPORTS_DIR, fname)
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)

    json_fname = f"forecast_data_{date.today().isoformat()}.json"
    json_path = os.path.join(REPORTS_DIR, json_fname)
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(pred, f, indent=2, ensure_ascii=False, default=str)

    return _file_meta(path, fname, "Forecast Report")


def _file_meta(path: str, fname: str, label: str) -> dict:
    st = os.stat(path)
    created = datetime.fromtimestamp(st.st_mtime)
    return {
        "id": fname,
        "filename": fname,
        "label": label,
        "type": _file_type(fname),
        "size": st.st_size,
        "size_display": _format_size(st.st_size),
        "created_at": created.isoformat(timespec="seconds"),
        "created_display": created.strftime("%b %d, %Y · %I:%M %p"),
    }


def generate(export_type: str) -> dict:
    generators = {
        "prices_csv": generate_prices_csv,
        "metrics_json": generate_metrics_json,
        "correlation_xlsx": generate_correlation_xlsx,
        "forecast_report": generate_forecast_html,
    }
    fn = generators.get(export_type)
    if not fn:
        raise ValueError(f"Unknown export type: {export_type}")
    return fn()

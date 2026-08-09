# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AgriPricePH — a Philippine rice price monitoring & forecasting system. It scrapes/imports
rice, fuel, USD/PHP, weather, and stock data into SQLite, trains an LSTM (or MLP fallback)
to forecast the Local Well-Milled rice price 2 days ahead, and serves a public site +
admin dashboard from one Flask app.

Full narrative docs already exist in the repo — read them before making non-trivial changes:
- [README.txt](README.txt) — setup, folder layout, admin credentials, troubleshooting
- [SYSTEM_GUIDE.txt](SYSTEM_GUIDE.txt) — end-to-end architecture and the exact ML math (scaling, sequencing, loss formulas, inference steps)

## Commands

All Python commands need `py -3.13` (project standard; avoid 3.14 — TensorFlow doesn't support it yet). Run from the `AgriPricePH/` project root unless noted.

```bash
# Install deps
py -3.13 -m pip install -r requirements.txt
py -3.13 -m pip install tensorflow   # optional; without it, sklearn MLP is used as fallback

# Build/refresh the SQLite database (first-time setup, or to pull in new 2026 data)
cd datasets && py -3.13 script.py && py -3.13 import_2026.py
# or: double-click setup_database.bat / import_2026.bat from project root

# Start the backend (must cd into api/ first — app.py uses relative paths)
cd api && py -3.13 app.py
# or: double-click run_backend.bat
# Health check: http://127.0.0.1:5000/api/health

# Train the model directly (same as Admin → Training → Start Training)
cd model && py -3.13 train.py
# Override epoch count: set AGRIPRICE_EPOCHS env var before running

# Run the scraper standalone (outside the Flask auto-scrape loop)
cd api && py -3.13 app.py --once              # single scrape cycle then exit
cd api && py -3.13 app.py --loop --interval 3600
cd api && py -3.13 app.py --serve --port 8080 # custom port/host for the server itself
```

There is no test suite, linter, or JS build step in this repo — frontend is plain HTML/CSS/JS served as static files, no bundler/npm project.

### Opening the app

- Same-origin (recommended, avoids CORS): `http://127.0.0.1:5000/` once `api/app.py` is running — Flask serves both the public site and the admin dashboard itself.
- Via XAMPP/Live Server instead: `public/landpage.html` (public) and `admin/login.html` (admin), with the Flask API still running separately on :5000.
- Admin login: `admin/login.html` — username `admin`, password `Admin@123`, 6-digit code `123456` (see README.txt for lockout/security behavior).

## Architecture

### Data flow (source → DB → model → API → UI)

```
DA PDF/HTML, fuel site, USD API, 2026 XLSX
        │  (tools/scrap.py, datasets/import_2026.py — auto-run on app.py startup)
        ▼
datasets/agriprice_database.db  (SQLite)
        │  model/data_pipeline.py: load_merged_frame()
        │  outer-merges retail_prices+WS_rice_price, fuel_history+WS_fuel,
        │  usd_php_rates+WS_currency, weather_data, rice_stock by Date; ffill/bfill
        ▼
   ┌─────────────┴─────────────┐
   ▼                           ▼
model/train.py             model/predict.py
(MinMaxScaler → 30-day      (same fitted scaler → last 30-day
 sequences → LSTM/MLP)       window → 2-day forecast)
   │                           │
   ▼                           ▼
lstm_model.keras/           /api/predictions
rice_mlp.joblib, meta.json      │
   │                           ▼
   └──────────────────►  api/app.py (Flask, port 5000)
                          REST + SSE + serves static frontend
                               │
                               ▼
                    public/*.html + admin/*.html (fetch via js/api.js)
```

Key ML constants (`model/data_pipeline.py`): `SEQ_LEN=30` days input window, `HORIZON=2` days
forecast, 5 input features (`locWellMilled, locPremium, fuel, exchange, rainfall`), single
target `locWellMilled`. Training does an 80/20 chronological (non-shuffled) split and requires
≥50 sequences (≥81 rows of merged data) or it errors out. TensorFlow LSTM is preferred;
if unavailable, `train.py`/`predict.py` transparently fall back to an sklearn `MLPRegressor`
(flattened 30×5 input) — `meta.json`'s `backend` field records which one produced the current model.

### Backend — `api/app.py`

Single Flask app (`app.py`, ~2300 lines) that does three jobs:
1. **REST API** under `/api/*` — historical data, scraper control, training control (with SSE
   log streaming via `/api/stream-training` and `/api/stream-scrape`), predictions, admin auth,
   settings, alerts, reports. See SYSTEM_GUIDE.txt §9 for the full endpoint list.
2. **Static file server** — the catch-all route at the bottom (`serve_frontend`) serves
   `public/` and `admin/` directly from disk so the whole app runs same-origin on :5000 with
   no separate frontend build/server needed.
3. **CLI modes** via argparse: default `--serve` runs Flask; `--once` runs a single scrape and
   exits; `--loop` runs the scraper forever without Flask (useful for a standalone cron-like process).

Long-running work (training, scraping) runs in background threads, not request handlers —
clients poll `/api/training-status` / `/api/scrape-status` or subscribe to the SSE stream endpoints.
Model inference is cached/warmed in a background thread at startup (`predict.warm_cache()`).

Admin auth (`model/admin_auth.py`) issues a server-side session token (not a client-only flag),
hashes the 6-digit security code server-side, and locks out after 5 failed attempts for 15 minutes.

### Frontend — three JS layers, no framework/bundler

- `js/` — shared across both sites: `api.js` (backend base URL/client), `data.js` (fallback
  mock data when the backend is unreachable), `charts.js`, `dates.js`.
- `public/js/` — vendor/household-facing: `public-shell.js` (layout), `public-auth.js` /
  `public-auth-modal.js` (login/signup — demo accounts live only in browser `localStorage`,
  there's no real user DB), `public-data.js` / `public-forecast.js` (charts + forecast cards),
  `public-rice.js` (defines the 8 rice type keys used everywhere: `imp/loc` ×
  `Special/Premium/WellMilled/Regular`).
- `admin/js/` — staff dashboard, built as a lightweight SPA: `router.js` loads HTML fragments
  from `admin/pages/*.html` into `admin/index.html`'s shell, one JS module per module
  (`training.js`, `predictions.js`, `historical.js`, `web-scraper.js`, `data-sources.js`,
  `alerts.js`, `settings.js`, `reports.js`, `dashboard.js`) each calling the matching `/api/*`
  endpoints and, for training/scraping, consuming the SSE log streams directly.

`public/` and `admin/` are deliberately separated (different audiences, different auth), but
both are served by the same Flask instance and share `css/global.css` and `js/`.

### Data/ML scripts (`datasets/`, `model/`, `tools/`)

- `datasets/script.py` — one-time bulk import of historical (2015–2025) XLSX/CSV into SQLite.
- `datasets/import_2026.py` — syncs current-year daily XLSX/CSV (rice, fuel, USD); also
  auto-runs on every `app.py` startup so the DB stays current without manual steps.
- `tools/scrap.py` — live scraper (`fetch_rice_prices`, `fetch_fuel_prices`,
  `fetch_exchange_rates`) writing into `WS_*` SQLite tables and CSV backups under
  `tools/scrapped */`; runs automatically every 24h from `app.py` and can be triggered manually
  via `/api/run-scraper`. `tools/pdfconvrt.py` parses DA price-bulletin PDFs for this.
- `model/settings_store.py` / `model/system_settings.json` — persisted app settings (API URLs,
  intervals, etc.) editable from Admin → Settings.
- `model/alerts_engine.py` — price alert rule evaluation, backed by `alerts_rules.json` /
  `alerts_log.json`.

When adding a new data source or feature column, it needs to be threaded through
`model/data_pipeline.py`'s merge (`load_merged_frame`) and, if it should influence forecasts,
added to `FEATURE_COLUMNS` — then the model must be retrained since `scaler.joblib` and
`meta.json` are fit to the old feature set.

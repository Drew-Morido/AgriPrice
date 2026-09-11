# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AgriPricePH — a Philippine rice price monitoring & forecasting system. It scrapes/imports
rice, fuel, USD/PHP, and stock data into SQLite, trains a multivariate LSTM (or MLP fallback)
per rice type to forecast retail prices for all 8 rice types up to 3 days (48–72h) ahead, and
serves a public site + admin dashboard from one Flask app.

Full narrative docs already exist in the repo — read them before making non-trivial changes:
- [README.txt](README.txt) — setup, folder layout, admin credentials, troubleshooting
- [SYSTEM_GUIDE.txt](SYSTEM_GUIDE.txt) — end-to-end architecture and the exact ML math (scaling, sequencing, loss formulas, inference steps)
- [documents/](documents/) — the capstone paper (`AgriPrice_Draft_Revised.docx`) and `PAPER_CORRECTIONS.md`

## Keep the capstone paper and code in sync (required)

This repo is a capstone project: the running app must match what the paper
(`documents/AgriPrice_Draft_Revised.docx`) claims, because it is defended before a panel.
**Whenever you change anything the paper describes, cross-check the document against the code
and reconcile both.** Paper-relevant surfaces include: the feature/input set, data sources,
forecast horizon, train/val/test split, evaluation metrics and baselines, and the UI scope
(desktop/mobile).

- `documents/PAPER_CORRECTIONS.md` is the authoritative **doc↔app reconciliation log** — read it
  first, and update it with every paper-relevant change.
- After a change, verify the paper's claims still hold against the code (features in
  `model/meta.json`, `HORIZON`/split in `model/train.py`, sources in `tools/scrap.py`, live
  `/api/predictions` and Admin → Metrics). If wording drifts, update the `.docx` too.
- Never let the paper claim something the app does not do (e.g., "beats the baseline"): the
  honest evaluation result is that the LSTM ≈ naive persistence ≈ ARIMA at this horizon.

## Commands

All Python commands need `py -3.13` (project standard; avoid 3.14 — TensorFlow doesn't support it yet). Run from the `AgriPricePH/` project root unless noted.

```bash
# Install deps
py -3.13 -m pip install -r requirements.txt
py -3.13 -m pip install tensorflow==2.20.0   # optional, version-pinned (see requirements.txt); without it, sklearn MLP is used as fallback

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
- Via XAMPP/Live Server instead: `public/landpage.html` for both public and admin — there is no separate admin login page — with the Flask API still running separately on :5000.
- Admin login: shares the public site's real login page (`public/login.html`, styled by `public/css/auth-hero.css` + `public/js/auth-hero.js` — enter the admin username instead of an email and it follows up with a 6-digit code prompt in the same card). Username `admin`, password `Admin@123`, 6-digit code `123456` (see README.txt for lockout/security behavior). `admin/js/admin-auth.js` redirects any unauthenticated visit to `admin/*` out to `public/login.html`. The site's shared "Log in"/"Sign up" nav buttons (`public/js/public-shell.js` + `public/js/public-auth-modal.js`) also go straight to `public/login.html` / `public/signup.html` now; the old unified login/signup **modal** in `public-auth-modal.js` still exists and still opens for the gated-content unlock prompts on `historical.html`/`statistics.html` and any `?auth=login`/`?auth=signup` deep link, but is no longer the primary login/signup entry point.

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
 sequences → LSTM/MLP)       window → 3-day forecast)
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

Key ML constants (`model/data_pipeline.py`): `SEQ_LEN=30` days input window, `HORIZON=3` days
forecast (48–72h). Raw `FEATURE_COLUMNS = fuel_ron95, fuel_diesel, stock, farmgate, exchange`;
`add_engineered_features()` adds seasonal sin/cos, 7-day rolling diesel/exchange, and the target's
lag-1/lag-7/rolling-7 — ~13 features total. A separate model is trained **per rice type** (8 total:
`locWellMilled, locRegular, locPremium, locSpecial, imp*` — `TARGET_COLUMN` names the default type).
Training uses a **regime-aware chronological split** (`train.py::_split_indices`, no shuffling):
validation and test are both drawn from the daily-observation era (`ACTIVE_FROM=2025-04-01`), while
training keeps the full history. This replaced a plain 70/15/15, which put TRAIN at 81% / VAL at 88%
/ TEST at 26% forward-filled "no price change" rows — so early stopping was selecting weights on an
almost-static validation set while the model was scored on a period where prices move.
`AGRIPRICE_LEGACY_SPLIT=1` reproduces the old behaviour.

**The split fix is a measurement fix, not a performance fix — do not present it as one.** Replayed
over the *same* test window, the pre-fix and post-fix models are indistinguishable (MAE 0.4090 vs
0.4100; skill −0.35% vs −0.66%; movement 0.042 vs 0.044; skill improved for 1 of 8 types). That null
result is itself the useful finding: the LSTM reproduces the naive forecast not because the flat
training signal suppressed it, but because for a near-random-walk series the last observed value *is*
the optimal predictor. When comparing runs, only compare on a fixed test window — a raw MAE
difference between runs is dominated by how forward-filled each run's test period happened to be.
Runs are **seeded** (`AGRIPRICE_SEED`, default 42) so reported metrics are reproducible. The
`MinMaxScaler` is fit on training rows only (leakage guard), and ≥50 train sequences are required.
**Anchored-delta mode is the default** (`AGRIPRICE_DELTA_MODE=1`): the net predicts the change from
the last price and inference reconstructs the level — opting out silently retrains the worse
level-mode model.

`meta.json` (v4) records per-type MAE/RMSE/MAPE/R², persistence + ARIMA(1,1,1) baselines,
rolling-origin, shock metrics, the ADF p-value, and the honest headline metrics:
`hit_rate_pct` (% of forecasts within ₱0.50/1.00/1.50/2.00, per forecast day),
`skill_vs_baseline_pct`, `directional_pct`, and `movement` (how far the model moves vs how far
prices really move — the number that exposes a collapsed model). **Do not report `accuracy_pct`**:
that legacy formula (`100 − MAE/mean_price`) returns 98–99% for any model and scores the naive
baseline *above* the LSTM on all 8 rice types; it is kept only so pre-v4 runs still render.

`meta.json.lstm_ablation` (pooled, plus per-type) records whether the network contributes anything
the mean-reversion coefficient does not — a paired McNemar test on **genuine-signal forecasts only**
(last change non-zero and price actually moved), because on ~13% of moving-price forecasts the
reversion term is structurally silent (`phi * 0 == 0`), `sign(0)` matches nothing, and counting those
rows inflates the network's apparent directional contribution by ~9 points when it is in fact
coin-flipping them at 50.7%. Current verdict: 158 fixes vs 150 breaks, **p = 0.69, not significant**.
**Do not "improve" this by widening the subset or by scoring a window that overlaps training** — under
the regime-aware split only ~342 rows per type are held out, and scoring the full active era instead
credits the network for memorised rows (this produced a spurious p < 0.0001 in Round 19; see
`documents/PAPER_CORRECTIONS.md`). Any candidate improvement must win on a window it was not tuned on:
nine estimator families have now been tested and rejected on exactly that criterion.

`predict.py` attaches a **conformal prediction interval** (`low`/`high`/`interval_pct`) to every
forecast day, calibrated on the last 60 observations so it tracks the current regime. Conformal
only guarantees its nominal level on *exchangeable* data, and daily price errors are not, so the
nominal level is set to **0.93 to deliver ~90% realised** coverage (measured 90.3% by walk-forward
recalibration); `interval_pct` reports the realised 90%. The older "90.2–90.8%" figure was
measured a different way — see PAPER_CORRECTIONS.md Round 12 for the calibration sweep. TensorFlow LSTM is
preferred; if unavailable, `train.py`/`predict.py` fall back to an sklearn `MLPRegressor` —
`meta.json.backend` records which produced the current model.

**Forecast = anchor + LSTM delta + a gated mean-reversion term** (`model/mean_reversion.py`). The
LSTM *on its own* collapses to the naive forecast (`movement_ratio` 0.07, skill −1%), because ~73%
of its training targets are forward-filled zeros while the deployment regime is only ~4% flat.
Retraining on the active regime does not fix it (skill −7%, 0/8). What does: the active-regime
first differences are strongly mean-reverting (lag-1 autocorrelation −0.17 to −0.41, Ljung–Box
p < 0.0001, t = −3.0 to −7.2), so one OLS coefficient per horizon — fit on the validation window
only, shrunk ×0.8, clipped to [−1, 0], and deployed only when |t| ≥ 2 — recovers it. With that
term the model **does** beat naive persistence: **skill +3.51%, positive on 7/8 types,
directional accuracy 57–67%, `movement_ratio` 0.24**. Shrinkage is 0.6 and a second lag was tested and rejected (dominated end-to-end at every shrink level). See PAPER_CORRECTIONS.md Rounds 11, 13 and 15. The coefficient is re-fitted on a rolling 120-day window before each forecast (`mean_reversion.rolling_phi`) rather than frozen at training time — scoring and serving use the same path, so they cannot diverge.

State this precisely: the **combined** model beats persistence and ARIMA; the **LSTM alone does
not**. Round 16 went further and measured the network's *marginal* contribution by ablation — it
is **negative on all 8 rice types**, so its delta is down-weighted to `LSTM_DELTA_WEIGHT=0.25`
(w=0 scores best; 0.25 keeps it in the path, disclosed). Current: **skill +3.71%, 8/8 types
positive, worst +1.25, directional 55–66%**. Never attribute the gain to the network — the
ablation table in Round 16 is the evidence and a panel will ask.

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
  `public-auth-modal.js` (login/signup — accounts are server-side: `model/user_store.py`
  (SQLite, `model/agriprice_users.db`, gitignored) + `model/user_auth.py` (werkzeug-hashed
  passwords, email-based password reset via `model/mailer.py`/Gmail SMTP); pre-existing
  browser-`localStorage` demo accounts migrate over automatically on next login from the same
  browser — see `public-auth.js`'s `login()`), `public-data.js` / `public-forecast.js` (charts + forecast cards),
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

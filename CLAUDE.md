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
- Never let the paper claim something the app does not do. The honest evaluation result: the
  **LSTM network alone** ≈ naive persistence (skill −1.29%, ablation p = 0.69); the **published
  adaptive ensemble** beats naive (+10.34%) and ARIMA (8/8) on the test window. Always say which one.
- The `.docx` was reconciled on 2026-09-27 (Ch. 1 limitations, Ch. 2 counter-evidence, Ch. 3 data
  span/split/baselines/ensemble, plus a draft Ch. 4–5 built from `meta.json`). Edit it by patching
  `word/document.xml` only: its four images are PNGs stored as `*.undefined`, which python-docx can
  only open after adding a `Default Extension="undefined"` content type (already added). Red
  `[UPDATED …]`/`[TEAM INPUT REQUIRED …]` notes mark edits and open team-only items.

## Commands

All Python commands need `py -3.13` (project standard; avoid 3.14 — TensorFlow doesn't support it yet). Run from the `AgriPricePH/` project root unless noted.

```bash
# Install deps
py -3.13 -m pip install -r requirements.txt
py -3.13 -m pip install tensorflow==2.20.0   # optional, version-pinned (see requirements.txt); without it, sklearn MLP is used as fallback

# Build/refresh the SQLite database (first-time setup, or to pull in new 2026 data)
cd datasets/scripts && py -3.13 script.py && py -3.13 import_2026.py
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

Tests: `py -3.13 -m pytest tests -q` (193 tests: model/API contracts, the verified rice history rebuild, the DA daily-bulletin reader, admin roles, Google sign-in, security fixes, the DA bulletin reader, the scraper guard, the DOE fuel reader, weekday reversion, the ensemble, the forecast log; API tests skip if :5000 is down). No linter or JS build step — frontend is plain HTML/CSS/JS served as static files, no bundler/npm project.

### Opening the app

- Same-origin (recommended, avoids CORS): `http://127.0.0.1:5000/` once `api/app.py` is running — Flask serves both the public site and the admin dashboard itself.
- Via XAMPP/Live Server instead: `public/landpage.html` for both public and admin — there is no separate admin login page — with the Flask API still running separately on :5000.
- Admin login: shares the public site's real login page (`public/login.html`, styled by `public/css/auth-hero.css` + `public/js/auth-hero.js` — enter the admin username instead of an email and it follows up with a 6-digit code prompt in the same card). Username `admin`, password `Admin@123`, 6-digit code `123456` on a fresh install only: a session opened with either default can do nothing but replace them (`admin/js/admin-credentials.js` → `POST /api/admin/me/credentials`; server returns 403 `must_change_credentials` elsewhere). See README.txt for lockout/security behavior. `admin/js/admin-auth.js` redirects any unauthenticated visit to `admin/*` out to `public/login.html`. The site's shared "Log in"/"Sign up" nav buttons (`public/js/public-shell.js` + `public/js/public-auth-modal.js`) also go straight to `public/login.html` / `public/signup.html` now; the old unified login/signup **modal** in `public-auth-modal.js` still exists and still opens for the gated-content unlock prompts on `historical.html`/`statistics.html` and any `?auth=login`/`?auth=signup` deep link, but is no longer the primary login/signup entry point.

## Architecture

### Data flow (source → DB → model → API → UI)

```
DA PDF/HTML, DOE NCR fuel PDF (weekly), USD API, 2026 XLSX
        │  (tools/scrap.py, datasets/scripts/import_2026.py — auto-run on app.py startup)
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
coin-flipping them at 50.7%. Current verdict (daily-bulletin retrain 2026-10-07): 113 fixes vs 120 breaks, **p = 0.69, not significant** (the 2018–2022
daily bulletins doubled the disagreements tested, from 107 to 233, without changing the verdict).
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

**The published forecast is an adaptive ensemble** (`model/ensemble.py`, default on; `AGRIPRICE_ENSEMBLE=0`
serves the plain hybrid). Three forecasters are weighted each day by 1 / (their MSE over the last 30 realised
forecasts), per rice type and forecast day (Bates & Granger): (1) the LSTM hybrid described below, (2) ARIMA(1,1,1),
(3) a local-level Kalman filter with a noise variance per weekday (DA's Sunday bulletin is ~5x noisier). Past errors
only; training scores it on the test window (`meta.json` `forecaster: adaptive_ensemble`; the hybrid's own numbers sit
under each type's `hybrid`). Current (daily-bulletin retrain 2026-10-07): **skill +10.34%, beats ARIMA on 8/8, every type beats naive (worst impWellMilled
+2.25%)**, price-range coverage 90.9% realised. The ensemble also beats ARIMA re-fitted from Oct 2018, from 2021 or on the
daily era only, 8/8 under each (`model/experiments/arima_daily_era_check.json`). Honest caveats, keep them in the paper: impRegular's day-1 direction fell
to chance (48.6% on 208 moves, not significantly below 50%; the hybrid had 62.5%), impPremium to 52.4%, and the test
window was reused across many experiments (a forward evaluation is the clean confirmation). The LSTM ablation still
shows no significant network contribution (p = 0.69) — the gain is the ensemble's, never the network's. See
PAPER_CORRECTIONS.md "Adaptive ensemble deployed". Forward evaluation: every freshly built forecast is logged before its
DA price exists (`model/forecast_log.py`, table `forecast_log`, `GET /api/forecast-check`), and forecast moves under
₱0.10 are published as direction "steady" (`predict.STEADY_PESO`). Forecast day *h* is dated **last DA data day + h**
(`_build_forecasts_by_key` anchor), not today + h — the public "Tomorrow" card means "the day after the latest bulletin".

**The LSTM hybrid = anchor + LSTM delta + a gated mean-reversion term** (`model/mean_reversion.py`). The
LSTM *on its own* collapses to the naive forecast (`movement_ratio` 0.07, skill −1%), because ~73%
of its training targets are forward-filled zeros while the deployment regime is only ~4% flat.
Retraining on the active regime does not fix it (skill −7%, 0/8). What does: the active-regime
first differences are strongly mean-reverting (lag-1 autocorrelation −0.17 to −0.41, Ljung–Box
p < 0.0001, t = −3.0 to −7.2), so one OLS coefficient per horizon — shrunk, clipped to [−1, 0],
and deployed only when |t| ≥ 2 — recovers it. With that term (Round 13, before the weekday and
rolling-window changes below) the model first beat naive persistence: skill +3.51%, 7/8 types,
`movement_ratio` 0.24; the current hybrid is +8.03%, 8/8. Shrinkage is 0.6 and a second lag was tested and rejected (dominated end-to-end at every shrink level). See PAPER_CORRECTIONS.md Rounds 11, 13 and 15. The coefficient is re-fitted on a rolling 120-day window before each forecast (`mean_reversion.rolling_phi`) rather than frozen at training time — scoring and serving use the same path, so they cannot diverge.
**The coefficient is weekday-aware** (`mean_reversion.WEEKDAY_MODE`, default on): the anchor day's weekday
gets its own coefficient, because DA's Sunday bulletin (fewer markets) is ~5× noisier than weekdays and is
reversed on Monday, while Thursday/Friday moves persist. Chosen on the validation window only
(`model/experiments/weekday_reversion.py`), it lifted test skill **+3.42% → +7.80%** (8/8 types improved).
`AGRIPRICE_REVERSION_WEEKDAY=0` restores the single global coefficient.

State this precisely: the **combined** model beats persistence on all 8 types, but beats
**ARIMA(1,1,1) on 6 of 8** as a *hybrid* (locSpecial PHP 0.2390 vs ARIMA 0.2296 and impSpecial 0.3464 vs 0.3386 go to
ARIMA), the same against the best of four ARIMA fitting windows. It was 3 of 8 before the 2026-10-06 rice rebuild — mostly
ARIMA getting worse on the newer test window, not the hybrid improving. The published *ensemble* beats ARIMA on 8/8 — say which one you mean. Do not write "beats ARIMA" without that qualifier; the panel can check
it in one command. The defensible framing is that the two are close, and that this system adds
prediction intervals, 8 simultaneous targets, and a daily operational pipeline that a single-series
ARIMA does not. The **LSTM alone does
not**. Round 16 went further and measured the network's *marginal* contribution by ablation — it
is **negative on all 8 rice types**, so its delta is down-weighted to `LSTM_DELTA_WEIGHT=0.25`
(w=0 scores best; 0.25 keeps it in the path, disclosed). Current (daily-bulletin retrain 2026-10-07): **skill +8.03%, 8/8 types
positive, worst +1.97 (impWellMilled), directional 45–66% per horizon**. The weekday gain is the
reversion term's, not the network's (the ablation above is unchanged). Never attribute the gain to the network — the
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
Two admin roles: **Super Admin** (the built-in `admin` plus any account given that role) can do everything; **Admin**
is a day-to-day operator with no User Management, view-only Settings and Training, and no clearing logs or deleting
report files. The server enforces it (`api/app.py::_require_super_admin`, `_um_guard`; `tests/test_user_roles.py`);
the UI mirrors it through `<html data-admin-role>` (`admin/js/admin-auth.js` → `.super-only` / `.admin-only` CSS in
`admin/css/modules.css`, and `superOnly` routes in `router.js`). Public-site accounts are labelled "Public User"
(stored role value is still `retailer`). Add Admin is a wizard (basic info + optional photo → role → password →
PIN entered then re-entered → review) with live validation; clicking a table row opens a profile summary. Admin
accounts have their own photo (`admin_accounts.avatar`, changeable by the admin in Account Profile via
`PUT /api/admin/me/avatar`). New accounts get a one-time welcome popup (`js/welcome-modal.js`), tracked server-side
in `users.welcome_seen_at` / `admin_accounts.welcome_seen_at` (accounts that existed before were backfilled as seen).
"Continue with Google" (public users only, never admins): Google Identity Services on `public/login.html` /
`signup.html` → `POST /api/auth/google`, verified server-side with google-auth (`model/google_signin.py`: issuer,
audience = `AGRIPRICE_GOOGLE_CLIENT_ID` from `.env`, verified email). Links by `users.google_sub`, else by the same
email, else creates a password-less account (set one later via "Forgot password?"). Only the Client ID is used —
never put the OAuth client secret in the project. The button hides itself when no Client ID is configured.

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
  `alerts.js`, `settings.js`, `reports.js`, `dashboard.js`, `users.js`) each calling the matching `/api/*`
  endpoints and, for training/scraping, consuming the SSE log streams directly.

`public/` and `admin/` are deliberately separated (different audiences, different auth), but
both are served by the same Flask instance and share `css/global.css` and `js/`.

### Data/ML scripts (`datasets/`, `model/`, `tools/`)

- **`datasets/` layout (since 2026-10-07, map in `datasets/README.md`)**: `agriprice_database.db` (live DB, stays at the
  top) · `1_factor_csv/` one final CSV per factor, 2015 → latest · `2_backup_database/by_factor/` one SQLite copy per
  factor + `full_snapshots/` (every pre-change DB copy; scripts write them via `paths.backup_path()`) · `3_source_files/`
  everything downloaded/received (DA-AMAS bulletin + DPI PDFs, DA weekly xlsx, parsed CSVs, PSA OpenSTAT downloads incl.
  wholesale, World Bank workbook, DOE PDFs, legacy workbooks) · `scripts/` all import/rebuild scripts. Every path comes
  from `datasets/scripts/paths.py`; `datasets/scripts/export_factors.py` rewrites folders 1 and 2 from the DB after every
  successful scrape (`api/app.py::_export_factor_files`) and at the end of `script.py`. Edit the DB, never the copies.

- `datasets/scripts/script.py` — one-time bulk import of historical (2015–2025) XLSX/CSV into SQLite.
- `datasets/scripts/import_2026.py` — syncs current-year daily XLSX/CSV (rice, fuel, USD); also
  auto-runs on every `app.py` startup so the DB stays current without manual steps.
- `tools/doe_fuel.py` — reads DOE's weekly "Price Monitoring of Liquid Fuels — NCR" PDFs (summary table, common
  price per product; Dec 2024 onward) with GasWatch PH as fallback and as the same-week filler for a DOE "#N/A".
  WS_fuel rows carry `Source` (`doe_ncr_weekly`/`gaswatchph`) and `Filled`; `datasets/scripts/import_doe_fuel.py` rebuilds them.
  From the first DOE week on, `load_merged_frame` ignores `fuel_history` (the 2015–2025 dataset runs PHP 10–20 above
  DOE in 2025) — see PAPER_CORRECTIONS.md "Fuel source replaced with DOE". The old Zigwheels source froze in May 2026.
- **Rice price history is rebuilt from official sources only** (`datasets/scripts/rebuild_verified_rice_history.py`, run last by
  `script.py`; table `rice_price_provenance` says where each day came from; `tests/test_rice_history_rebuild.py`):
  Jan 2015 – Sep 2018 PSA OpenSTAT old-series NCR monthly retail (`2M/RP/0042M4ARP01`; one figure held across each month;
  local = imported; PSA's blank Nov–Dec 2015 / May–Jun 2016 repeat the prior month); Oct 2018 – 2022 DA DAILY bulletins
  (`datasets/scripts/fetch_da_bulletins.py` caches the PDFs listed on da.gov.ph/price-monitoring into
  `datasets/3_source_files/DA-AMAS/daily_bulletins_pdf/` (PDFs gitignored); `datasets/scripts/parse_da_daily_bulletins.py`
  classifies each page's layout and reads only known layouts → `3_source_files/DA-AMAS/parsed/da_daily_bulletins.csv`,
  refusals → `da_daily_bulletins_review.csv`; `tests/test_da_bulletin_reader.py`);
  2023 – Feb 2025 DA weekly prevailing (the daily bulletins then publish only a low–high RANGE, deliberately not converted);
  Mar 2025 on DA Daily Price Index. A daily figure is carried up to 14 days before a weekly one may be used; longer gaps take
  PSA's month. The original `DATASETS_RETAIL_PRICE_2015_2025.xlsx` matched no PSA or DA table
  and no longer contributes any value. Never re-run `smooth_unverified_2015_2019.py` (it now refuses) — it would ramp the
  flat PSA months. Expect a level shift on 2018-10-01 (PSA NCR average → DA prevailing price).
- `tools/psa_openstat.py` — PSA OpenSTAT (PXWeb API) monthly national rice stocks + palay farmgate, 2015 onward, into
  `PSA_rice_stocks` / `PSA_farmgate` (`datasets/scripts/import_psa.py` for a manual load). The pipeline prefers these over the old
  `rice_stock` / `farmgate_prices` tables and uses each month's figure from the 15th of the next month (`MONTHLY_RELEASE_LAG`).
- Catch-up: each scrape cycle stores any DA bulletin from the last 45 days with no DA row (`scrap.backfill_rice_bulletins`)
  and fills USD/PHP days without a rate from a dated archive (`scrap.backfill_exchange_rates`, `RATE_HISTORY_URL`, rows
  tagged `WS_currency.Source = currency_api_archive`). Never overwrites a stored value. One-off/longer range:
  `cd datasets/scripts && py -3.13 backfill_missing_days.py [--since YYYY-MM-DD]` (backs up the DB, reports what is still missing).
- Data readiness: `data_pipeline.evaluate_readiness` — the merged frame ends at the newest day whose DA bulletin (never an
  `estimated` row), DOE fuel week (≤14 days) and USD/PHP rate (≤4 days) are all present (`GET /api/data-readiness`).
- Auto-scraper (`api/app.py::_loop_scraper`): full sync every `scrape_interval_hours` (Admin → Settings), DA-only retries
  every 2 h 7:00–21:00 until today's bulletin is in; `/api/scrape-status` → `stats.schedule`.
- `tools/scrap.py` — live scraper (`fetch_rice_prices`, `fetch_fuel_prices`, `fetch_psa_monthly`,
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

## Price alerts and Market Drivers (2026-10-28, `tests/test_alerts_auto.py`)

- Alerts are checked automatically after every scrape, every forecast refresh (`predict.REFRESH_LISTENERS`) and at
  server start, through `api/app.py::_run_alert_check` only; it notifies the admin bell (unread count) and, when
  Settings → Notifications → Email alerts is on, emails `alert_email`. A rule fires once per DA bulletin day per type.
- Default rules (`alerts_engine.default_rules_for`) are created once per id (`model/alerts_state.json`); never re-add a
  default the admin deleted.
- Market Drivers stock / rainfall / month / tariff come from `model/market_drivers.py`; never type fixed r values into
  `admin/js/correlation.js` again. Tariff stays "not calculated" while `tariff_schedule` has a single rate.

## Live-database writes (2026-10-28, `tests/test_db_write.py`)

- Never rewrite a live table with `DataFrame.to_sql(..., if_exists="replace")`: it drops the table before the new rows
  exist, and a forecast built in that window read no DOE fuel weeks, cut the data at Jan 12, 2026 and cached those
  prices. Use `tools/db_write.replace_table(conn, df, name)` (side table + DROP/RENAME in one transaction). The
  scraper, PSA/macro refresh, `import_2026.py` (runs at every server start) and `import_doe_fuel.py` use it.
- The server turns off Windows console QuickEdit (`api/app.py::_disable_console_quickedit`) and does not print one line
  per HTTP request (`AGRIPRICE_ACCESS_LOG=1` brings them back): a click in the backend window used to freeze every
  request that logged, until someone clicked the window again.

## Security rules (2026-10-01 audit, `tests/test_security.py`)

- Lockouts key on `request.remote_addr` (X-Forwarded-For only with `AGRIPRICE_TRUST_PROXY=1`) **and** on the
  account (`_account_key`); only a full admin sign-in (password + PIN) clears the count. Reset codes die after 5 wrong tries.
- `GET /api/settings` returns only display options to non-admins; never the file path. Credentials and the admin
  username cannot be set through `PUT /api/settings`; Reset Defaults keeps the `security` section.
- The admin token is read from `Authorization` / `X-Admin-Token` headers only, never `?token=`.
- `after_request` adds CSP (script/style/font/connect hosts are listed in `_CSP` — add a host there before using a
  new CDN), `X-Frame-Options`, `nosniff`, `Referrer-Policy`; account/admin API answers are `Cache-Control: no-store`.
- Alerts, live training/scrape logs and the scrape review list are admin-only reads. Brand uploads are checked by
  their first bytes. Never add an unauthenticated endpoint that writes files.

# AgriPricePH

**Philippine rice price monitoring & 3-day LSTM-based forecasting system.**

AgriPricePH scrapes and imports rice, fuel, USD/PHP, stock and farmgate data into SQLite, trains one multivariate LSTM per rice type (with an sklearn MLP fallback), and publishes a 1–3 day (48–72h) forecast for all **8 rice types** as an adaptive ensemble of the LSTM hybrid, ARIMA(1,1,1) and a weekday Kalman filter. One Flask application serves both a **public site** (for vendors and households) and an **admin dashboard** (for staff).

---

## Features

- 📈 **3-day price forecast** for 8 rice types (Imported/Local × Special, Premium, Well-Milled, Regular), each with a calibrated ~90% price range
- 🧠 **LSTM-based adaptive ensemble** — per-type LSTM (30-day window, 13 features) + weekday mean-reversion, combined with ARIMA(1,1,1) and a Kalman filter by recent accuracy. Test window: skill +10.06% vs naive, better than ARIMA on 8/8 types (see `SYSTEM_GUIDE.txt` §0 for the caveats)
- 🧾 **Forward evaluation** — every published forecast is logged before its DA price exists (`/api/forecast-check`)
- 🛡️ **Scraper guard** — position-based DA PDF reading plus a plausibility check that holds suspicious prices for admin review
- 🕸️ **Automated data pipeline** — scrapes/imports rice, fuel, exchange-rate, weather, and stock data into SQLite
- 🔐 **Secure admin dashboard** — server-issued session tokens, hashed 6-digit security code, lockout after 5 failed attempts
- 🌐 **Same-origin app** — one Flask instance serves the REST API, SSE log streams, and the static frontend (no bundler/npm)
- 🔔 **Price alerts, historical charts, and exportable reports**

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.13, Flask, Flask-CORS |
| ML / Data | TensorFlow (LSTM) · scikit-learn (MLP fallback) · pandas · NumPy · statsmodels · joblib |
| Scraping | requests · BeautifulSoup4 · pdfplumber · openpyxl |
| Database | SQLite |
| Frontend | Plain HTML / CSS / JavaScript (no framework, no build step) |

---

## Project structure

```
AgriPricePH/
├── index.html            → redirects to public/landpage.html
├── public/               Vendor & household site (landing, prices, forecast, history, stats)
├── admin/                Staff dashboard (SPA: training, predictions, scraper, alerts, settings…)
├── css/global.css        Shared theme
├── js/                   Shared scripts (api.js, data.js, charts.js, dates.js)
├── api/app.py            Flask backend — REST + SSE + static file server (port 5000)
├── model/                ML train/predict, data pipeline, admin auth, settings, alerts
├── datasets/             SQLite DB, factor CSVs, backups, source files, scripts (see datasets/README.md)
├── tools/                Web scraper + PDF parser
├── documents/            Capstone paper (.docx) + PAPER_CORRECTIONS.md reconciliation log
├── requirements.txt
├── run_backend.bat / setup_database.bat
├── README.txt            Detailed setup & troubleshooting
└── SYSTEM_GUIDE.txt      Full architecture & ML math
```

---

## Getting started

> All Python commands use `py -3.13` (project standard — avoid 3.14; TensorFlow doesn't support it yet). Run from the `AgriPricePH/` project root unless noted.

### 1. Install dependencies

```bash
py -3.13 -m pip install -r requirements.txt
py -3.13 -m pip install tensorflow==2.20.0   # optional, version-pinned — without it, the sklearn MLP fallback is used
```

### 2. Build the database (first-time setup)

```bash
cd datasets/scripts
py -3.13 script.py
py -3.13 import_2026.py
```

Or double-click `setup_database.bat` from the project root.

### 3. Start the backend

```bash
cd api
py -3.13 app.py
```

Or double-click `run_backend.bat`. Then verify: <http://127.0.0.1:5000/api/health>

> ⚠️ `app.py` uses relative paths — you **must** `cd api` first. Running `py app.py` from the project root will fail.

### 4. Open the app

- **Recommended (same-origin, no CORS):** <http://127.0.0.1:5000/> once the backend is running — Flask serves both sites.
- **Via XAMPP / Live Server:** `public/landpage.html` for both public and admin — there's no separate admin login page; sign in from its "Log in" button — with the Flask API still running on port 5000.

---

## Admin sign-in

Admin sign-in shares the public site's unified login modal (click **Log in** on `public/landpage.html`). Enter the admin username/password; a 6-digit access-code prompt follows automatically before you're redirected into `admin/index.html`.

| Field | Default |
|-------|---------|
| Username | `admin` |
| Password | `Admin@123` |
| Security code | `123456` |

> 🔒 **Change these before any real deployment** (Admin → Settings → Security). Credentials are stored as hashes server-side; 5 failed attempts trigger a 15-minute lockout.

---

## Training the model

- **From the UI:** Admin → Training → Start Training
- **From the CLI:**

  ```bash
  cd model
  py -3.13 train.py           # set AGRIPRICE_EPOCHS to override epoch count
  ```

Forecasts are then available at Public → `forecast.html` and Admin → Predictions.

---

## API endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/health` | Server check |
| GET | `/api/historical-data` | Price charts |
| GET | `/api/predictions` | 3-day forecast (8 rice types, with ranges and direction) |
| GET | `/api/forecast-check` | Forward evaluation of logged forecasts |
| POST | `/api/run-training` | Start training |
| POST | `/api/admin/verify` | Admin login → session token |
| GET | `/api/admin/session` | Validate token |
| POST | `/api/admin/logout` | End admin session |
| GET / PUT | `/api/settings` | Read / save system settings |

Training and scraping stream live logs over SSE (`/api/stream-training`, `/api/stream-scrape`).

---

## How it works

```
Data sources (DA PDF/HTML, fuel site, USD API, XLSX)
        │  tools/scrap.py · datasets/scripts/import_2026.py  (auto-run on app.py startup)
        ▼
datasets/agriprice_database.db  (SQLite)
        │  model/data_pipeline.py → merged frame (rice, fuel, FX, weather, stock)
        ▼
model/train.py  →  LSTM / MLP  →  model/predict.py (hybrid → ensemble)  →  /api/predictions
        │              (30-day window, 3-day horizon, 13 features)
        ▼
api/app.py (Flask :5000) → public/*.html + admin/*.html
```

**Key ML constants:** 30-day input sequence, 3-day forecast horizon, 13 features (5 raw: RON95, diesel, stock, farmgate, USD/PHP; plus seasonal, rolling and target-lag features), one model per rice type, regime-aware chronological split (train to 2025-03-31, validation and test from the daily-observation era).

For the full architecture and exact ML math (scaling, sequencing, loss, inference), see [`SYSTEM_GUIDE.txt`](SYSTEM_GUIDE.txt). For detailed setup and troubleshooting, see [`README.txt`](README.txt).

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `can't open file app.py` | `cd api` first — `app.py` is inside `api/`, not the root |
| Blank charts / "Cannot reach backend" | Start `run_backend.bat` and keep it open; test `/api/health` |
| Database empty or missing | Run `setup_database.bat` once (backend also auto-imports on startup) |
| Port 5000 in use | Close other `app.py` terminals, or `py -3.13 app.py --serve --port 5001` |
| Styles/scripts missing after Ctrl+F5 | Hard refresh to clear cache |

---

## Notes

This is an academic/capstone project. Tests: `py -3.13 -m pytest tests -q` (74 tests). There is no JS build step — the frontend is plain static files served by Flask. User accounts are server-side (`model/user_store.py`, hashed passwords).

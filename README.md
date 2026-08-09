# AgriPricePH

**Philippine rice price monitoring & 2-day LSTM forecasting system.**

AgriPricePH scrapes and imports rice, fuel, USD/PHP, weather, and stock data into SQLite, trains an LSTM (with an sklearn MLP fallback) to forecast the **Local Well-Milled** rice price two days ahead, and serves both a **public site** (for vendors and households) and an **admin dashboard** (for staff) from a single Flask application.

---

## Features

- 📈 **2-day price forecast** for 8 rice types (Imported/Local × Special, Premium, Well-Milled, Regular)
- 🧠 **LSTM model** (30-day input window, 5 features) with automatic sklearn `MLPRegressor` fallback when TensorFlow is unavailable
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
├── datasets/             SQLite DB + historical/2026 import scripts
├── tools/                Web scraper + PDF parser
├── documents/            Exported reports
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
py -3.13 -m pip install tensorflow   # optional — without it, the sklearn MLP fallback is used
```

### 2. Build the database (first-time setup)

```bash
cd datasets
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
- **Via XAMPP / Live Server:** `public/landpage.html` (public) and `admin/login.html` (admin), with the Flask API still running on port 5000.

---

## Admin sign-in

| Field | Default |
|-------|---------|
| URL | `admin/login.html` |
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
| GET | `/api/predictions` | 2-day forecast (8 rice types) |
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
        │  tools/scrap.py · datasets/import_2026.py  (auto-run on app.py startup)
        ▼
datasets/agriprice_database.db  (SQLite)
        │  model/data_pipeline.py → merged frame (rice, fuel, FX, weather, stock)
        ▼
model/train.py  →  LSTM / MLP  →  model/predict.py  →  /api/predictions
        │              (30-day window, 2-day horizon, 5 features)
        ▼
api/app.py (Flask :5000) → public/*.html + admin/*.html
```

**Key ML constants:** 30-day input sequence, 2-day forecast horizon, 5 features (`locWellMilled`, `locPremium`, `fuel`, `exchange`, `rainfall`), single target `locWellMilled`, chronological 80/20 split.

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

This is an academic/capstone project. There is no automated test suite or JS build step — the frontend is plain static files served by Flask. Demo vendor accounts live only in browser `localStorage`; there is no real end-user account database.

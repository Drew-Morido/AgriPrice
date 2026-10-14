# AgriPricePH — Audio-Visual Presentation (AVP) for the IT Expert evaluation

**Length:** about 4:20 – 4:40 (minimum 3:20). **Narration:** 667 words, read by a text-to-speech (TTS) voice: about
4:37 at 150 words per minute or 4:20 at 160 wpm, with a 1-second pause between scenes. The timings below assume
150 wpm; re-time the clips to the generated audio. **Video:** 1920×1080 screen recordings of the running system, plus a few
simple diagram cards.

**What it covers:** how the system works end to end (architecture, data collection, data quality, forecasting,
evaluation), every module of the admin dashboard and the public website, and security and reliability. These are the
points an IT expert checks under ISO 25010: functional suitability, performance efficiency, reliability, security, and
maintainability.

Every number comes from the current model (`model/meta.json`, retrained 2026-10-07), the live database, and the test
suite. If the model is retrained before the video is made, re-check the numbers in Scene 6 in Admin → Model Dashboard.

---

## 1. Scene list

| # | Time | Scene | What the viewer sees |
|---|---|---|---|
| 1 | 0:00 – 0:21 | Title and purpose | Title card → public landing page |
| 2 | 0:21 – 0:48 | System architecture | Architecture diagram card |
| 3 | 0:48 – 1:26 | Automated data collection | Admin → Data Sources (7/7) → Web Scraper schedule and live log |
| 4 | 1:26 – 1:56 | Data quality and storage | Held for review → Data Sources "Used by the model from" → `datasets` folder |
| 5 | 1:56 – 2:29 | Forecasting engine | Forecasting diagram card → admin Price Forecast with its price range |
| 6 | 2:29 – 3:00 | Training and evaluation | Model Training (split, loss curve, log) → Model Dashboard → results card |
| 7 | 3:00 – 3:29 | Admin dashboard modules | Quick cuts through every admin module |
| 8 | 3:29 – 3:55 | Public website | Home → Price Forecast → Rice Catalog → Price History → Charts & Stats → Sign up |
| 9 | 3:55 – 4:16 | Security | Admin login with the PIN step → User Management roles |
| 10 | 4:16 – 4:29 | Reliability and testing | Terminal running the automated tests → forecast log |
| 11 | 4:29 – 4:37 | Closing | Title card with team, school, adviser |

---

## 2. Scene-by-scene script

### Scene 1 — Title and purpose (0:00 – 0:21)

**Visual:** Title card "AgriPricePH — Rice Price Monitoring and Forecasting System" (3 s), then the public landing page
(`http://127.0.0.1:5000/`), scrolling slowly.

**Narration:**
> This is AgriPricePH, a web-based system that monitors and forecasts the retail prices of eight rice types in Metro
> Manila, up to three days ahead. This video explains how the system works, from data collection to forecasting, and
> walks through every module of the admin dashboard and the public website.

**On-screen text:** "8 rice types · NCR · forecasts up to 3 days ahead"

---

### Scene 2 — System architecture (0:21 – 0:48)

**Visual:** An architecture diagram card, built in four rows, one row per sentence:
1. Sources: DA · DOE · PSA · World Bank · Exchange rate · Tariff Commission
2. Scraper and importers (Python), feeding the SQLite database
3. Forecasting engine (TensorFlow + statsmodels), feeding the Flask REST API
4. Public website + admin dashboard (HTML, CSS, JavaScript, Chart.js)

**Narration:**
> AgriPricePH runs as one Python Flask application. Flask provides the REST API and also serves both the public website
> and the admin dashboard, which are built with HTML, CSS, and JavaScript. All data is stored in a SQLite database.
> Forecasting uses TensorFlow and statistical models in Python. Long tasks, such as scraping and model training, run in
> background threads, and their logs stream live to the dashboard.

**On-screen text:** "Flask REST API · SQLite · TensorFlow · HTML/CSS/JavaScript"

---

### Scene 3 — Automated data collection (0:48 – 1:26)

**Visual:**
1. Admin → **Data Sources**: the "Connected sources 7/7" card, then click down the list: DA, DOE, Exchange rates,
   Tariff, PSA, Core inflation, World rice price.
2. Admin → **Web Scraper**: the status cards, the Scraper Schedule table, then the Activity Log scrolling during a run.

**Narration:**
> The system collects data automatically from seven sources. Rice prices come from the Department of Agriculture's daily
> price bulletins, read directly from the PDF files. Diesel prices come from the Department of Energy's weekly
> bulletins. Rice stocks, palay farmgate prices, and core inflation come from the Philippine Statistics Authority's API,
> and the world rice price from the World Bank, along with the daily exchange rate and the rice import tariff. A full
> sync runs every twenty-four hours. If today's DA bulletin is not out yet, the scraper retries every two hours.

**On-screen text:** "7 sources · PDF extraction + APIs · full sync every 24 h · DA retry every 2 h"

---

### Scene 4 — Data quality and storage (1:26 – 1:56)

**Visual:**
1. Web Scraper → **Held for review** card.
2. Data Sources → Core inflation → the "Used by the model from" value.
3. File Explorer: `datasets` → `1_factor_csv` (open `rice_retail_prices_daily.csv`, zoom on the `source` column) →
   `2_backup_database` → `3_source_files\DA-AMAS\daily_bulletins_pdf`.

**Narration:**
> Data quality is checked before anything is used. A suspicious rice price is held for an admin to approve or reject.
> Monthly figures are used only from the date they are actually published. Every rice price since 2015 is traced to the
> PSA or DA publication it came from. The database is backed up before every change, each factor is exported to its own
> CSV file, and every downloaded source file is kept.

**On-screen text:** "Review queue · release-date rule · source per day · automatic backups"

---

### Scene 5 — Forecasting engine (1:56 – 2:29)

**Visual:**
1. A diagram card: "Last 30 days of prices + factors" → three boxes ("LSTM + mean reversion", "ARIMA", "Kalman filter")
   → "Weighted by accuracy over the last 30 days" → "3-day forecast + price range".
2. Admin → **Price Forecast**: the Next Day Prediction, then zoom on the low–high range in the Daily Forecast Table.

**Narration:**
> For forecasting, each rice type has its own model. It reads the last thirty days of prices and market factors and
> forecasts the next three days. The forecast combines three models: an LSTM neural network with a mean-reversion
> correction, an ARIMA model, and a Kalman filter. Each day, every model is weighted by its accuracy over the last
> thirty days. Each forecast also includes a calibrated price range that contains the actual price about ninety percent
> of the time.

**On-screen text:** "Adaptive ensemble: LSTM hybrid + ARIMA + Kalman filter · 8 models · 3-day horizon"

---

### Scene 6 — Training and evaluation (2:29 – 3:00)

**Visual:**
1. Admin → **Model Training**: the inputs in the subtitle, the Train / Validation / Test Split, the Loss Curve, and the
   Training Log (a recorded training run).
2. Admin → **Model Dashboard**: the actual-vs-forecast chart.
3. A results card with four large numbers:
   - **96%** of next-day forecasts within ₱1
   - **₱0.22 – ₱0.33** average error per kilo
   - **10.3%** lower error than "tomorrow = today"
   - **8 of 8** rice types better than ARIMA

**Narration:**
> Data from 2015 to March 2025 is used for training, April to October 2025 for validation, and one full year, October
> 2025 to October 2026, for testing. On that test year, ninety-six percent of next-day forecasts were within one peso of
> the actual DA price, with an average error of twenty-two to thirty-three centavos per kilo. The combined model's error
> was ten percent lower than repeating today's price, and it beat ARIMA on all eight rice types.

**On-screen text:** "Test year: Oct 2025 – Oct 2026 · never used in training"

---

### Scene 7 — Admin dashboard modules (3:00 – 3:29)

**Visual:** Quick cuts, about 2–3 s per module, each with its name as a small label, in sidebar order:
Dashboard Overview → Price Forecast → Price Alerts → Data Sources → Price History (switch to Core Inflation) → Web
Scraper → Taxes & Import Charges → Rice Brands → Market Drivers → Model Dashboard → Model Training → Reports & Export →
User Management → System Settings → System Logs → topbar search and notifications → Account Profile.

**Narration:**
> In the admin dashboard, the Dashboard Overview summarizes today's prices, forecasts, and accuracy. Price Forecast shows
> each rice type's forecast, chart, and table. Data Sources and Web Scraper monitor every source. Price History and
> Market Drivers show the full history and compare rice with diesel, inflation, and world prices. Admins also manage
> price alerts, reports in CSV, Excel, or PDF, import tariffs, rice brands, users, settings, and system logs.

**On-screen text:** "Admin dashboard: 16 modules"

---

### Scene 8 — Public website (3:29 – 3:55)

**Visual:**
1. **Home**, scrolling through its sections.
2. **Price Forecast**: the eight current prices, then the "Tomorrow" card with its up/down/steady arrow and range.
3. **Rice Catalog**: open one imported brand.
4. **Price History**, then **Charts & Stats**.
5. **Sign up** with "Continue with Google". Do not type a password on camera.

**Narration:**
> On the public website, users see today's prices and the three-day forecast, with an up, down, or steady direction and
> a price range. They can browse the price history, charts and statistics, and a rice catalog with estimated shelf
> prices that include import charges. Accounts can be created by email or Google to unlock the full history, a profile,
> and display settings.

**On-screen text:** "Public site: forecast · rice catalog · history · statistics · accounts"

---

### Scene 9 — Security (3:55 – 4:16)

**Visual:**
1. The admin sign-in: the password field already filled (masked), then the "6-digit code" step. Never show the real
   PIN.
2. Admin → **User Management**: the Super Admin and Admin role labels.

**Narration:**
> For security, passwords and admin PINs are stored only as hashes, and admins sign in with both a password and a
> six-digit PIN. Accounts lock for fifteen minutes after five failed attempts. Access is role-based, Super Admin and
> Admin, and enforced on the server, and every response carries security headers.

**On-screen text:** "Hashed credentials · password + PIN · lockout · role-based access · security headers"

---

### Scene 10 — Reliability and testing (4:16 – 4:29)

**Visual:**
1. A terminal running `py -3.13 -m pytest tests -q`, ending on "198 passed".
2. The browser at `http://127.0.0.1:5000/api/forecast-check`, showing the logged forecasts.

**Narration:**
> For reliability, a failed source never overwrites stored data, and every new forecast is logged before the actual
> price is known. The system is covered by one hundred ninety-eight automated tests.

**On-screen text:** "198 automated tests · forecasts logged before the actual price"

---

### Scene 11 — Closing (4:29 – 4:37)

**Visual:** Title card: "AgriPricePH", team names, school, adviser.

**Narration:**
> AgriPricePH: official data, collected automatically, checked, and turned into transparent short-term forecasts. Thank
> you for evaluating our system.

---

## 3. Narration only (paste into the TTS tool)

Put a 1-second pause between paragraphs. Most TTS tools accept a blank line or `<break time="1s"/>`.

```
This is AgriPricePH, a web-based system that monitors and forecasts the retail prices of eight rice types in Metro Manila, up to three days ahead. This video explains how the system works, from data collection to forecasting, and walks through every module of the admin dashboard and the public website.

AgriPricePH runs as one Python Flask application. Flask provides the REST API and also serves both the public website and the admin dashboard, which are built with HTML, CSS, and JavaScript. All data is stored in a SQLite database. Forecasting uses TensorFlow and statistical models in Python. Long tasks, such as scraping and model training, run in background threads, and their logs stream live to the dashboard.

The system collects data automatically from seven sources. Rice prices come from the Department of Agriculture's daily price bulletins, read directly from the PDF files. Diesel prices come from the Department of Energy's weekly bulletins. Rice stocks, palay farmgate prices, and core inflation come from the Philippine Statistics Authority's API, and the world rice price from the World Bank, along with the daily exchange rate and the rice import tariff. A full sync runs every twenty-four hours. If today's DA bulletin is not out yet, the scraper retries every two hours.

Data quality is checked before anything is used. A suspicious rice price is held for an admin to approve or reject. Monthly figures are used only from the date they are actually published. Every rice price since 2015 is traced to the PSA or DA publication it came from. The database is backed up before every change, each factor is exported to its own CSV file, and every downloaded source file is kept.

For forecasting, each rice type has its own model. It reads the last thirty days of prices and market factors and forecasts the next three days. The forecast combines three models: an LSTM neural network with a mean-reversion correction, an ARIMA model, and a Kalman filter. Each day, every model is weighted by its accuracy over the last thirty days. Each forecast also includes a calibrated price range that contains the actual price about ninety percent of the time.

Data from 2015 to March 2025 is used for training, April to October 2025 for validation, and one full year, October 2025 to October 2026, for testing. On that test year, ninety-six percent of next-day forecasts were within one peso of the actual DA price, with an average error of twenty-two to thirty-three centavos per kilo. The combined model's error was ten percent lower than repeating today's price, and it beat ARIMA on all eight rice types.

In the admin dashboard, the Dashboard Overview summarizes today's prices, forecasts, and accuracy. Price Forecast shows each rice type's forecast, chart, and table. Data Sources and Web Scraper monitor every source. Price History and Market Drivers show the full history and compare rice with diesel, inflation, and world prices. Admins also manage price alerts, reports in CSV, Excel, or PDF, import tariffs, rice brands, users, settings, and system logs.

On the public website, users see today's prices and the three-day forecast, with an up, down, or steady direction and a price range. They can browse the price history, charts and statistics, and a rice catalog with estimated shelf prices that include import charges. Accounts can be created by email or Google to unlock the full history, a profile, and display settings.

For security, passwords and admin PINs are stored only as hashes, and admins sign in with both a password and a six-digit PIN. Accounts lock for fifteen minutes after five failed attempts. Access is role-based, Super Admin and Admin, and enforced on the server, and every response carries security headers.

For reliability, a failed source never overwrites stored data, and every new forecast is logged before the actual price is known. The system is covered by one hundred ninety-eight automated tests.

AgriPricePH: official data, collected automatically, checked, and turned into transparent short-term forecasts. Thank you for evaluating our system.
```

---

## 4. Production checklist

**Before recording**
- Restart the backend (`cd api && py -3.13 app.py`) and let one scrape finish, so Data Sources shows 7/7 and the Web
  Scraper log has fresh lines.
- Record a short model training run for Scene 6 ahead of time (training takes several minutes); use only the clip.
- Browser at 100% zoom, full screen, bookmarks bar hidden, other tabs closed, light theme.
- Use a real Super Admin account, not the default one, so every module is visible. Never show a password, PIN, `.env`,
  or a user's email on screen.
- Record each admin module in Scene 7 as its own short clip, then cut them together at 2–3 s each.

**While editing**
- Generate the TTS audio first, then lay the clips over it; the narration sets the timing.
- If a clip is shorter than its narration, slow the clip or hold its last frame. Do not speed up the voice.
- Keep background music low (about −25 dB under the voice), or leave it out.
- Add the on-screen text as lower-thirds, plus burned-in captions of the narration.
- Final check: total length at least 3:20 (this script runs about 4:20 – 4:40), and every number on screen matches
  the narration.

**Keep these claims accurate**
- Say "the combined model". The accuracy comes from the ensemble of three models; tested alone, the LSTM performs
  about the same as repeating today's price.
- Do not quote an "accuracy" of 98–99%. That figure is a misleading legacy formula; use the within-₱1 rate (96%) and
  the 10.3% error reduction.
- The price-range coverage ("about ninety percent") was measured at 90.9% before the 2026-10-07 retrain. Run
  `cd model && py -3.13 experiments/interval_coverage_ensemble.py` once before the final cut to confirm it.
- The test count (198) is the current suite with the backend running. Re-run the tests before recording and use the
  number the terminal shows.

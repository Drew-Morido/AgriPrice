# AgriPricePH — AVP full narration (one block, for text-to-speech)

One continuous narration for the IT Expert evaluation video, which replaces the live demo. **Length:** 1,330 words,
about 9:10 at 150 words per minute or 8:35 at 160 wpm (pauses included). Paste the block in Section 1
into the TTS tool in one go. Blank lines are paragraph breaks (about a 1-second pause in most TTS tools).
Section 2 lists what to show on screen while each paragraph plays.

---

## 1. Narration (paste this into the TTS tool)

```
Good day. This is AgriPricePH, a web-based system that monitors and forecasts the retail prices of rice in Metro Manila. It covers eight rice types, local and imported special, premium, well-milled, and regular milled, and forecasts each one up to three days ahead. In this video, we explain how the system works and walk through its modules, starting with the admin dashboard and then the public website.

AgriPricePH runs as one Python Flask application. Flask provides the REST API and serves both the admin dashboard and the public website, which are built with HTML, CSS, and JavaScript. All data is stored in a SQLite database, and forecasting uses TensorFlow and statistical models in Python. Long tasks, such as data collection and model training, run in the background, and their progress streams live to the dashboard.

Administrators sign in through the same login page as public users, but an admin account needs a second step: a six-digit PIN after the password. After five failed attempts, the account is locked for fifteen minutes.

After signing in, the Dashboard Overview summarizes the whole system. It shows today's prices for all eight rice types, the latest forecasts, the share of forecasts within one peso, the average forecast error, the current diesel price, the dollar-to-peso rate, and a ninety-day trend of rice prices.

The Data Sources module shows where every piece of data comes from. Seven sources are connected, and all of them are collected automatically. Rice prices come from the Department of Agriculture's daily price bulletins. Diesel prices come from the Department of Energy's weekly bulletins for Metro Manila. The exchange rate comes from a daily currency service, and the rice import tariff from the Tariff Commission. From the Philippine Statistics Authority, the system takes monthly rice stocks, palay farmgate prices, and core inflation. From the World Bank, it takes the export price of Vietnamese five percent rice, the main source of the country's imported rice. For each source, the module shows the latest values, when it was last fetched, how many records are stored, and whether it is up to date. Monthly figures also show the date from which the model may use them, because a month is only used after it has actually been published. An admin can fetch any source on demand.

The Web Scraper module runs the data collection. The cards at the top show whether today's DA bulletin, fuel prices, and exchange rates are complete. The schedule lists every source and its next run: a full sync every twenty-four hours, and while today's DA bulletin is still missing, a retry every two hours from seven in the morning to nine in the evening. The activity log shows each run live. A rice price that looks wrong, for example one far from the recent price, is never used automatically. It is held for review until an admin approves or rejects it.

The Price History module shows every recorded price from January 2015 to today, as a chart and a data table, with daily, weekly, monthly, and yearly views and CSV export. Every rice price comes from an official publication. January 2015 to September 2018 uses the Philippine Statistics Authority's monthly retail prices for Metro Manila. October 2018 to 2022 uses the DA's daily price bulletins, read automatically from about three thousand PDF files. 2023 to early 2025 uses the DA's weekly prevailing prices, and from March 2025, the DA Daily Price Index. Core inflation and the world rice price can be viewed here as well, one row per month. A Statistics tab summarizes the lowest, highest, and average prices and their distribution.

Market Drivers compares rice prices with the factors that may influence them, such as diesel, the exchange rate, core inflation, and the world rice price, and shows how strongly each one moves with the price of rice.

The Price Forecast module shows the forecast for each rice type: the next-day prediction, a chart comparing the forecast with recent actual prices, and a daily forecast table. Every forecast comes with a low and high range. The first forecast day is the day after the latest DA bulletin, so the system never assumes a price that has not been published.

Here is how each forecast is made. Every rice type has its own model, which reads the last thirty days of prices and market factors and predicts the next three days. Three methods are combined: an LSTM neural network with a mean-reversion correction, an ARIMA statistical model, and a Kalman filter. Each day, every method is weighted by how accurate it has been over the last thirty days, so the most reliable method counts the most. The price range is calibrated on recent errors, so that it contains the actual price about ninety percent of the time.

The Model Training module retrains all eight models when new data arrives. It lists the model inputs, shows how the data is split, and streams the training log and loss curve live. Data from 2015 to March 2025 is used for training, April to October 2025 for validation, and one full year, October 2025 to October 2026, for testing. Every training run is saved for comparison.

The Model Dashboard shows how accurate the model is. On the test year, ninety-six percent of next-day forecasts were within one peso of the actual DA price, and about eighty-seven percent were within fifty centavos, with an average error of twenty-two to thirty-three centavos per kilo. The combined model's error was ten percent lower than simply repeating today's price, and it beat ARIMA on all eight rice types. Every new forecast is also logged before the actual price is published, so accuracy keeps being checked going forward.

Taxes and Import Charges keeps the import tariff and other charges for imported rice. The system checks the Tariff Commission automatically, but a new rate is only applied after an admin approves it. The module also shows the tariff history and a preview of the resulting consumer price.

The remaining modules support daily operations. Price Alerts notifies staff when a price goes above or below a set level, or rises sharply, and keeps a log of every alert. Reports and Export creates price and forecast reports in CSV, Excel, or PDF. Rice Brands manages the brands shown in the public rice catalog. User Management handles public and admin accounts, with two admin roles: Super Admin, with full access, and Admin, for day-to-day operations. System Settings controls the scraping schedule, the enabled sources, and retraining, and System Logs records system activity. A search bar, notifications, and the admin's account profile are available from the top bar.

Next is the public website, made for consumers and vendors. The home page introduces the system, with rice information, a price preview, and frequently asked questions. The Price Forecast page shows today's prices for all eight rice types, based on the latest DA bulletin, and the forecast for the next three days. Each forecast shows whether the price is expected to go up, go down, or stay steady, with its likely range. The Rice Catalog lists rice brands by type with estimated shelf prices, including import charges for imported rice. Price History and Charts and Stats let users review past prices and their summary statistics. Users can sign up with email or Google to unlock the full history, and manage their profile and display settings, such as dark mode.

For security, passwords and PINs are stored only as hashes, admin access is enforced on the server by role, accounts lock after repeated failed attempts, and every response carries security headers. For reliability, a failed source never overwrites stored data, the database is backed up before every change, each factor is exported to its own CSV file, and every downloaded source file is kept. The system is covered by one hundred ninety-eight automated tests.

AgriPricePH turns official price data into an automatically updated rice price monitor with transparent short-term forecasts. Thank you for evaluating our system.
```

---

## 2. What to show for each paragraph

| ¶ | Narration topic | Show on screen |
|---|---|---|
| 1 | Introduction | Title card "AgriPricePH", then the public landing page |
| 2 | Architecture | Diagram card: Sources → Scraper → SQLite → Forecasting engine → Flask API → Admin + Public |
| 3 | Admin login | Login page, masked password, then the 6-digit code step (never show the real PIN) |
| 4 | Dashboard Overview | Dashboard: point at each card, then the 90-day trend |
| 5 | Data Sources | "Connected sources 7/7", click each source, Core inflation's "Used by the model from", Fetch Now |
| 6 | Web Scraper | Status cards, Scraper Schedule, Activity Log during a run, Held for review |
| 7 | Price History | Chart + table, period tabs, frequency dropdown, Core Inflation / World Rice categories, Statistics tab, Export CSV |
| 8 | Market Drivers | Diesel vs rice chart, driver list with core inflation and world rice |
| 9 | Price Forecast (admin) | Next Day Prediction, Forecast vs Historical chart, Daily Forecast Table with low–high range |
| 10 | How forecasting works | Diagram card: 30 days → LSTM + mean reversion / ARIMA / Kalman → weighted → 3-day forecast + range |
| 11 | Model Training | Inputs subtitle, Train/Validation/Test Split, Loss Curve, Training Log (pre-recorded run), Training Runs |
| 12 | Model Dashboard | Actual vs forecast chart, then a results card: 96% within ₱1 · ₱0.22–0.33 error · 10.3% · 8/8 vs ARIMA |
| 13 | Taxes & Import Charges | Tariff schedule, rate history, consumer-price preview |
| 14 | Other admin modules | 2–3 s each: Price Alerts → Reports → Rice Brands → User Management → Settings → Logs → search, bell, Account Profile |
| 15 | Public website | Home (scroll) → Price Forecast (Tomorrow card, arrow, range) → Rice Catalog → Price History → Charts & Stats → Sign up (Google) → Settings (dark mode) |
| 16 | Security & reliability | Login PIN step, User Management roles, `datasets` folder, terminal "198 passed" |
| 17 | Closing | Title card with team, school, adviser |

**Before recording:** restart the backend and let one scrape finish (Data Sources 7/7); use a Super Admin account;
record a training run ahead of time; re-run `py -3.13 -m pytest tests -q` and use the number it shows in ¶16; generate
the TTS first and cut the clips to the audio.

# 1. System overview

## What it is
AgriPricePH is a web-based system that **monitors and forecasts the retail price of rice in Metro Manila (NCR)**.
It tracks **8 rice types**: local and imported × special, premium, well-milled, regular milled, and forecasts each
one **up to 3 days ahead**. The main source of rice prices is the Department of Agriculture's daily price bulletins.

**Retail price**, as used everywhere in the system: the prevailing price per kilogram that consumers pay in Metro
Manila (NCR) markets, as monitored by the Department of Agriculture (DA-AMAS).

It has two sides:
- **Public website** for consumers and vendors: today's prices, the 3-day forecast, history, statistics, a rice catalog.
- **Admin dashboard** for staff: data sources, scraping, forecasts, model training and accuracy, alerts, reports, users.

## How it is built
```
Official sources (DA, DOE, PSA, World Bank, exchange rate, Tariff Commission)
      │  scraper + importers (Python), every 24 h, DA retried every 2 h until today's bulletin is out
      ▼
SQLite database  ── rice price history 2015 → today, each day traced to its publication
      │
      ▼
Forecasting engine (TensorFlow LSTM + ARIMA + Kalman filter, combined by recent accuracy)
      │
      ▼
Flask REST API  ── serves both websites from one application (port 5000)
      │
      ▼
Public website + Admin dashboard (HTML, CSS, JavaScript, Chart.js)
```
- One Python **Flask** application: the REST API and both websites.
- **SQLite** database (`datasets/agriprice_database.db`), backed up before every data change.
- Long tasks (scraping, training) run in the background; their logs stream live to the dashboard.
- 200 automated tests (model, API, security, data pipeline).

## Admin modules (sidebar order)
| Module | What it does |
|---|---|
| Dashboard Overview | Today's retail prices, the latest forecast, accuracy, diesel price, USD/PHP rate, 90-day trend |
| Price Forecast | 3-day forecast for all 8 types with a price range; **"Forecasting models today"** shows which of the 3 models carries the most weight |
| Price Alerts | Rules (price above/below a level, sharp rise) and a log of triggered alerts |
| Data Sources | The 7 sources: latest value, last fetch, records stored, up to date or not; Fetch Now |
| Price History | Every price from Jan 2015, chart + table, daily to yearly, core inflation and world rice price, CSV export, statistics |
| Web Scraper | Schedule, live log, Run Now, and the **Held for review** queue for suspicious prices |
| Taxes & Import Charges | Import tariff (new rates need admin approval), tariff history, consumer-price preview |
| Rice Brands | Brands mapped to the 8 types, with price and weight; feeds the public Rice Catalog |
| Market Drivers | Rice price compared with diesel, exchange rate, core inflation, world rice price |
| Model Dashboard | Accuracy of the forecast on the test year |
| **Forecast vs Actual** | **20-day replay: real price vs the forecast made the day before, with and without factors** |
| Model Training | Retrain the model; inputs, data split, live loss curve and log, past runs |
| Reports & Export | CSV, Excel, PDF reports and their history |
| User Management | Public users and admins; roles Super Admin and Admin |
| System Settings / Logs | Scraping schedule, enabled sources, retraining, session; live system activity |
| Top bar | Search across modules, notifications, account profile |

## Public pages
| Page | What it does |
|---|---|
| Home | Intro, today's retail prices, features, rice knowledge, FAQ |
| Price Forecast | Today's price of all 8 types and the 3-day forecast: up / down / steady (moves under ₱0.10 are "steady") and the likely range |
| Rice Catalog | Brands by type with estimated shelf prices, import charges included for imported rice |
| Price History | Past prices per type (sign-in required for the full history) |
| Charts & Stats | Lowest, highest, average and trends |
| Sign up / Log in | Email or Google; Forgot Password sends a code by email |
| Profile / Settings | Account info; light or dark display |

## Security
Passwords and admin PINs stored only as hashes; admin sign-in needs a password **and** a 6-digit PIN; accounts lock
for 15 minutes after 5 failed attempts; roles enforced on the server; security headers on every response.

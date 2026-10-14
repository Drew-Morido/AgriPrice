# AgriPricePH — Quick-demo AVP for the IT Expert (2–3 minutes)

One continuous narration for a fast walkthrough of the system that still covers everything it does at its core.
**Length:** 396 words, about 2:47 at 150 words per minute or 2:38 at 160 wpm (pauses included). Paste
Section 1 into the text-to-speech tool in one go; blank lines are short pauses. Section 2 lists what to show while each
paragraph plays.

---

## 1. Narration (paste this into the TTS tool)

```
This is AgriPricePH, a web-based system that monitors and forecasts the retail prices of eight rice types in Metro Manila, up to three days ahead. It runs as one Python Flask application with a SQLite database and a TensorFlow forecasting engine, and it serves an admin dashboard and a public website.

Admins sign in with a password and a six-digit PIN. The Dashboard Overview shows today's prices for all eight rice types, the latest forecasts, the forecast accuracy, the diesel price, and the exchange rate.

Data is collected automatically from seven sources: the Department of Agriculture's daily price bulletins, the Department of Energy's fuel prices, the Philippine Statistics Authority's rice stocks, farmgate prices, and core inflation, the World Bank's world rice price, the exchange rate, and the rice import tariff. The Web Scraper syncs every twenty-four hours, retries every two hours until the day's DA bulletin is out, and holds any suspicious price for an admin to review.

Price History shows every price from 2015 to today, and each rice price is traced to the PSA or DA publication it came from. Market Drivers compares rice prices with diesel, inflation, and world prices.

Price Forecast shows the next three days for each rice type, with a likely price range. Each forecast combines an LSTM neural network, an ARIMA model, and a Kalman filter, weighted by how accurate each one has been recently. On a full test year, ninety-six percent of next-day forecasts were within one peso of the actual DA price, and the error was ten percent lower than simply repeating today's price. Model Training retrains the models, and the Model Dashboard tracks their accuracy.

Admins also manage price alerts, reports in CSV, Excel, or PDF, import tariffs that must be approved before use, rice brands, user roles, settings, and system logs.

On the public website, anyone can check today's prices and the three-day forecast, which shows whether each price is expected to go up, go down, or stay steady. Users can browse price history and statistics, and a rice catalog with estimated shelf prices. Signing up with email or Google unlocks the full history.

Passwords and PINs are stored as hashes, access is role-based, the database is backed up before every change, and the system is covered by one hundred ninety-eight automated tests.

AgriPricePH: official data, collected automatically, turned into transparent short-term forecasts. Thank you.
```

---

## 2. What to show for each paragraph (fast cuts)

| ¶ | Topic | Show on screen |
|---|---|---|
| 1 | Introduction | Title card → public landing page |
| 2 | Login + Dashboard | Login with the PIN step (masked) → Dashboard Overview cards |
| 3 | Data collection | Data Sources "7/7" (click 2–3 sources) → Web Scraper schedule, live log, Held for review |
| 4 | Price History + Market Drivers | Price History chart (period "All") → Market Drivers diesel vs rice chart |
| 5 | Forecasting | Admin Price Forecast (chart + range) → Model Training log → Model Dashboard chart |
| 6 | Other admin modules | ~1.5 s each: Price Alerts → Reports → Taxes & Import Charges → Rice Brands → User Management → Settings → Logs |
| 7 | Public website | Price Forecast (Tomorrow card, arrow, range) → Price History → Charts & Stats → Rice Catalog → Sign up with Google |
| 8 | Security + reliability | User Management roles → terminal "198 passed" |
| 9 | Closing | Title card with team, school, adviser |

**Before recording:** restart the backend and let one scrape finish (Data Sources 7/7); use a Super Admin account;
never show a password, PIN, or user email; re-run `py -3.13 -m pytest tests -q` and use the number it shows in ¶8.

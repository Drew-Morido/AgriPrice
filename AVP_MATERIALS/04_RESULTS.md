# 4. Results

## A. Test year (Oct 11, 2025 – Oct 5, 2026, 359 days, never used to fit the model)
Published forecast (the combined model):

| Measure | Day 1 (tomorrow) | Day 2 | Day 3 |
|---|---|---|---|
| Within ₱1.00 of the real price | **96.2%** | 95.5% | 95.1% |
| Within ₱0.50 | **87.5%** | 84.5% | 82.4% |

- Average error **₱0.22 – ₱0.34 per kilo**, depending on the rice type (MAPE 0.4% – 0.8%).
- **10.3% lower error** than "tomorrow = today", and better than ARIMA alone on **all 8** rice types.
- Price range: contains the real price about 90% of the time (measured 90.9% before the Oct 7 retrain).

| Rice type | Average error | Lower error than "tomorrow = today" |
|---|---|---|
| Local Well-Milled | ₱0.28 | 13.5% |
| Local Regular Milled | ₱0.27 | 14.7% |
| Local Premium | ₱0.26 | 11.2% |
| Local Special | ₱0.22 | 15.1% |
| Imported Well-Milled | ₱0.28 | 2.2% |
| Imported Regular Milled | ₱0.34 | 3.6% |
| Imported Premium | ₱0.29 | 6.2% |
| Imported Special | ₱0.32 | 15.8% |

## B. Forecast vs Actual, Oct 7 – Oct 26, 2026 (20 days after the last retrain)
Day-1 forecast made the day before, from data available that day (Admin → Forecast vs Actual):

| All 8 types | Average error | Within ₱0.50 | Within ₱1.00 | vs "tomorrow = today" |
|---|---|---|---|---|
| **With factors** (published) | **₱0.215** | 91.2% | 98.8% | 5.7% lower |
| **Without factors** (price-only LSTM) | ₱0.216 | 91.2% | 98.8% | 5.3% lower |
| "Tomorrow = today" | ₱0.228 | 86.9% | 98.8% | — |

The two forecasts differ by **₱0.003** on average.

| Rice type | With factors | Without factors | Tomorrow = today | Real price moved |
|---|---|---|---|---|
| Local Well-Milled | ₱0.273 | ₱0.276 | ₱0.294 | ₱1.31 |
| Local Regular Milled | ₱0.280 | ₱0.282 | ₱0.285 | ₱1.12 |
| Local Premium | ₱0.288 | ₱0.287 | ₱0.305 | ₱0.88 |
| Local Special | ₱0.171 | ₱0.171 | ₱0.194 | ₱0.69 |
| Imported Well-Milled | ₱0.112 | ₱0.112 | ₱0.112 | ₱0.56 |
| Imported Regular Milled | ₱0.169 | ₱0.167 | **₱0.154** | ₱1.58 |
| Imported Premium | ₱0.272 | ₱0.273 | ₱0.299 | ₱0.80 |
| Imported Special | ₱0.158 | ₱0.158 | ₱0.180 | ₱1.48 |

**How to read it:** the forecast follows the real price as it moves; over 20 days it beat "tomorrow = today" on 6
types, tied on 1 and lost on 1 (Imported Regular). The factors change the next-day forecast by less than a centavo.

## C. Forward log (forecasts saved before the real price existed)
Every new forecast is logged before the DA price is published. As of Oct 26: 88 forecasts scored; day-1 error
₱0.22 vs ₱0.25 for "tomorrow = today" (10.6% lower), range covered the real price 92% of the time. Still small, and it
has gaps from the days the system was off.

## How to state the results (and what not to say)
- Say **"the combined model"** or **"the system's forecast"**, not "the LSTM", when quoting accuracy.
- Say the forecast is **"closer than repeating the previous day's price"**; quote 10.3% for the test year and about 6%
  for the 20-day window, not a bigger figure.
- Say the factors **do not change the short-term forecast**; they are shown in Market Drivers to explain price
  movements.
- Never quote "98–99% accuracy" (a legacy formula that gives that number to any model).
- Caveats to own: Imported Regular in the 20-day window; the test window was reused across experiments, so the
  forward log is the cleanest evidence going forward.

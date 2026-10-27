# 3. Forecast and model

## In one paragraph
Each rice type has its own model (8 in total). It looks at the **last 30 days** and forecasts the **next 3 days**.
Three methods are combined: an **LSTM neural network with a mean-reversion correction** ("LSTM hybrid"), **ARIMA**,
and a **Kalman filter**. Every day, each method gets a weight based on how accurate it was over its **last 30
forecasts**, for that rice type and forecast day; the more accurate, the bigger its share. Each forecast comes with a
**price range** that contains the real price about 9 times in 10.

## Inputs
Rice price (the target), diesel price, USD/PHP rate, rice stocks, palay farmgate price, core inflation, world rice
price (Viet Nam 5%), and season (time of year). Only the LSTM receives the factors; ARIMA and the Kalman filter use the
price only.

## The three methods
| Method | What it does | Strength |
|---|---|---|
| LSTM hybrid | Neural network on the last 30 days of price + factors, plus a mean-reversion term (DA's price changes tend to partly reverse the next day; the coefficient depends on the weekday, because the Sunday bulletin is noisier) | Captures the day-to-day reversal pattern |
| ARIMA(1,1,1) | Classic time-series model on the price only | Strong, simple baseline |
| Kalman filter | Smooths out noise in the daily price, with more noise allowed on Sundays | Steady when prices bounce |

**Weights:** 1 ÷ each method's error over its last 30 forecasts (Bates & Granger). On most days they are close
(about 30–37% each). The admin Price Forecast page shows today's split as "Forecasting models today".

**Price range:** set from the combined forecast's last 60 errors (conformal method), tuned to cover about 90%.

**"Tomorrow"** in a forecast means the day after the latest DA bulletin.

## How the data was split
| Part | Dates | Purpose |
|---|---|---|
| Training | Jan 2015 – Mar 31, 2025 | Fit the network |
| Validation | Apr 1 – Oct 10, 2025 | Choose settings, stop training |
| Test | Oct 11, 2025 – Oct 5, 2026 | Score it, once: a full year never used to fit it |

Then **Oct 7 – Oct 26, 2026** was used for the Forecast vs Actual replay: also never used to fit the model.

## What we learned about the LSTM (be ready to explain)
- On its own, the LSTM network does about as well as "tomorrow = today". The accuracy comes from combining it with the
  reversion term, ARIMA and the Kalman filter.
- Measured directly: removing the network's contribution does not make the forecast significantly worse (ablation,
  p = 0.80), and its output barely depends on the factors.
- Two attempts to make it learn more from the factors (Oct 2026) made the test accuracy worse, so they were not used.
- Rice prices day to day move close to a random walk: the price's own recent movement carries most of the
  information for a 1–3 day forecast. That is why the forecast with and without factors is almost the same.

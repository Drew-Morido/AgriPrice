# AgriPricePH — AVP, 1:45 (forecast vs actual, with and without factors)

**Length:** about 1:42 (242 words at 150 words per minute, pauses included). **Core:** a 20-day replay, Oct 7 – Oct 26,
2026, of the real DA retail price against the forecast made the day before, with and without the factors
(Admin → **Forecast vs Actual**). The model was fitted on data through Mar 31, 2025, so none of these days was used to fit it.

Numbers below are from that page (all 8 rice types, Oct 7–26): average error ₱0.21 with factors, ₱0.22 without,
₱0.23 for "tomorrow = today"; within ₱0.50 on 91% of days, within ₱1.00 on 99%; the two forecasts differ by ₱0.003
on average. Re-check them on the page before recording.

---

## 1. Scene list

| # | Time | Narration topic | Show on screen |
|---|---|---|---|
| 1 | 0:00 – 0:12 | What it is | Title card (2 s) → public Price Forecast page |
| 2 | 0:12 – 0:28 | Automatic data | Admin → Data Sources (7/7) → Web Scraper log |
| 3 | 0:28 – 1:14 | **The 20-day replay** | Admin → **Forecast vs Actual**, Local Well-Milled, speed **Slow (for video)**, press **Play**; end on the three summary cards |
| 4 | 1:14 – 1:30 | Today's forecast | Admin → Price Forecast: 3-Day Price Forecast card, "Forecasting models today", the price range |
| 5 | 1:30 – 1:42 | Close | Title card: team, school, adviser |

**Scene 3 timing:** Slow speed is 2.4 s per day, so 20 days take 48 s, which fits the 46-second paragraph. Start
recording, press Play, and let it run to the end; trim the clip to the narration.

---

## 2. Narration (paste into the TTS tool; one block per paragraph)

**Block 1**
```
Agri Price P H monitors and forecasts the retail price of eight rice types in Metro Manila, up to three days ahead, using the Department of Agriculture's daily price bulletins.
```

**Block 2**
```
Every day, it collects its data automatically from seven official sources: D A rice prices, D O E fuel prices, the exchange rate, P S A rice stocks, farmgate prices and core inflation, and the World Bank's world rice price.
```

**Block 3**
```
This page replays twenty days, October seventh to twenty-sixth, that the model never saw while it was being fitted. Each purple point is the forecast for that day, made the day before. Then the green line shows the real D A price. The price rises and falls, and the forecast follows it. On average it was off by about twenty-one centavos per kilo, and within one peso on ninety-nine percent of days, closer than simply repeating the day before's price. The orange line is the same forecast without the factors. It lands almost on top of the purple one: for a next-day forecast, the price's own recent movement does most of the work, and the factors barely change it.
```

**Block 4**
```
Every forecast also comes with a likely price range, and the forecast page shows which of the three models, the L S T M, ARIMA or the Kalman filter, carries the most weight today.
```

**Block 5**
```
Agri Price P H: official data, collected automatically, and forecasts you can check against the real price, day by day. Thank you.
```

For Google AI Studio: use the same Scene and Sample Context as before (calm, informative, steady pace, read acronyms
letter by letter, "Agri Price P H").

---

## 3. On-screen text (lower-thirds)

| Scene | Text |
|---|---|
| 1 | 8 rice types · Metro Manila · retail price · 3-day forecast |
| 2 | 7 official sources, collected automatically |
| 3 (start) | Oct 7 – 26, 2026 · 20 days the model never saw |
| 3 (end) | Average error ₱0.21 · within ₱1 on 99% of days · with and without factors: almost identical |
| 4 | Price range + strongest model today |

---

## 4. Recording checklist

- Restart the backend and wait for one scrape. Open Admin → Forecast vs Actual once and wait for "Updated …" (the
  first load can take a minute while it prepares).
- Check that From = Oct 7, 2026 and To = Oct 26, 2026, and the rice type is Local Well-Milled.
- Set Replay speed to **Slow (for video)**, start recording, then press **Play**. Do not touch the mouse until the last day.
- Record the other scenes as separate clips; never show a password, PIN, or email.
- Generate the audio first, then lay the clips under it. Final length 1:35 – 1:45.

**What to say if the panel asks "so the factors don't help?":** For a next-day forecast, the price's own recent
movement carries almost all the information, so adding the factors changes the forecast by less than a centavo on
average, in this window and on the full test year. The factors are still collected and shown in Market Drivers,
where they explain why prices move, and they are an input the model can use for longer horizons in future work.

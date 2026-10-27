# 6. Panel Q&A (short answers)

**Where do the prices come from?**
DA price bulletins for NCR: daily bulletins Oct 2018 – 2022, DA-AMAS weekly prevailing prices 2023 – Feb 2025, the DA
Daily Price Index from Mar 2025. Jan 2015 – Sep 2018 is PSA's monthly NCR retail price, the only official series for
those years. Every day in the database records which publication it came from.

**Why weekly for 2023 – early 2025?**
The daily bulletins then printed only a low–high range, not a prevailing price. Using DA's own weekly prevailing price
is more accurate than guessing from a range.

**What if DA has not published today?**
The scraper retries every 2 hours from 7 AM to 9 PM. Until then the forecast starts from the latest official bulletin;
an estimate is never used by the model.

**How accurate is it?**
On a full test year: 96% of next-day forecasts within ₱1, average error ₱0.22–₱0.34 per kilo, 10.3% lower error than
"tomorrow = today", better than ARIMA on all 8 types. On 20 days after the last retrain: ₱0.21 average error, within ₱1
on 99% of days.

**So do the factors help?**
Not for a 1–3 day forecast: with and without them the forecast differs by less than a centavo on average. Day to day,
the price's own recent movement carries the information. The factors are still collected and shown in Market Drivers,
where they explain why prices move, and they are the natural input for longer-horizon forecasts (future work).

**Why combine three models instead of using the LSTM?**
On its own the LSTM does about as well as "tomorrow = today". Combining it with ARIMA and a Kalman filter, weighted by
recent accuracy, is what beats both the naive forecast and ARIMA alone.

**Why only 3 days ahead?**
Beyond that, daily rice prices are too close to a random walk for a forecast to be reliable.

**Why core inflation and not headline inflation? Why Viet Nam 5%?**
Core inflation leaves out food and energy, so it does not repeat the rice and diesel prices already in the model. Viet
Nam is the main source of the country's imported rice.

**Why no fertilizer or wholesale prices?**
The PSA fertilizer series stops in 2019 and is a wholesale price; the system forecasts retail prices.

**How is the data protected from scraping errors?**
Suspicious prices are held for admin review, monthly figures are used only after publication, the database is backed
up before every change, and the original PDFs and files are kept.

**Is it secure?**
Hashed passwords and PINs, password + PIN for admins, lockout after 5 failed attempts, server-side roles, security
headers, 200 automated tests.

**Scalability (IT Expert)?**
Built for one site: SQLite in WAL mode with one scheduled writer, training in a separate process. For many users or
servers, the next steps are PostgreSQL and a task queue such as Celery (listed as future work).

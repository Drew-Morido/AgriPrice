# AgriPricePH — To-do list from all feedback

Sources: **IT Expert** (software engineer / web developer), **DA-AMAS** (previous meeting and evaluation), **Ma'am Shein**
(technical adviser). Plus the items still open from earlier work. Size: **S** = under 2 h, **M** = half a day, **L** = a day or more.
"Me" = code work I can do in this repo; "Team" = needs your group (data, recording, people).

Order of work: **Phase 1** quick wins → **Phase 2** the new comparison module (biggest) → **Phase 3** paper, docs, and the video.

---

## A. Ma'am Shein (technical adviser)

### A1. New admin module: forecast vs actual, with factors vs without factors — **L**, me *(Phase 2)*
Show, side by side for any rice type and date range: the **actual price**, the forecast **with the factors**, and the
forecast **without the factors**, with the error of each.
- [ ] Train a second set of 8 models that use the price only (same split, same test year), so "without factors" is a
      fair comparison, and not just another model name. (~1 h of training)
- [ ] Backtest chart: three lines (actual, with factors, without factors) and a table with MAE, % within ₱1, and
      skill vs "tomorrow = today" for each.
- [ ] **Moving prices:** a Play button that replays the days one by one: the actual price appears, the forecast made
      *before* that day is shown beside it, and the running error updates. Plus a live section fed by the
      forward log (`forecast_log`), which fills in every day as real DA prices arrive.
- [ ] Add it to the sidebar, the search index, and the Admin → Model Dashboard link.
- **Heads-up, decide before the panel:** our own tests show the factors do **not** change the LSTM's output (it
  ignores them), and ARIMA and Kalman use the price only. So the two lines will probably be **almost identical**.
  That is an honest finding, not a bug, and it matches the ablation (p = 0.69). We should label them "Full model
  (uses factors)" and "Price-only model", and explain it. Do not describe the accuracy gain as coming from the
  factors. Let's agree on that wording before the AVP.

### A2. AVP: forecast price vs the actual price in the local market — **M**, me + team *(Phase 3)*
- [ ] Decide what "actual price in the local market" means: **(a)** the DA retail price we already have (a full test
      year, 359 days) or **(b)** also a price you collect yourselves at a local market.
- [ ] If (b): **Team** collects actual prices at one NCR wet market for 7–14 days (same 8 rice types, same time each
      day, with the market name and date). I'll make the recording sheet and compare it with the forecast made the
      day before. This is independent evidence, and the strongest one for the panel.
- [ ] Add a "Forecast vs actual" scene (~20 s) to the AVP quick script and the visual guide, recorded from the new
      module (A1). I'll write the narration once the numbers exist, so they match.

---

## B. DA-AMAS

| # | Task | Size | Who |
|---|---|---|---|
| B1 | ✅ **Done 2026-10-14.** **Retail price wording:** "retail price (₱/kg)" on every public page, the admin modules, charts, exports, and reports; add a one-line definition (prevailing retail price, NCR) | S | Me |
| B2 | ✅ **Done 2026-10-28** (checks after every scrape, forecast refresh and server start; bell with unread count; email when switched on in Settings). **Automated alerts:** run the alert check after every scrape and every forecast refresh (today it only runs at startup and when the Alerts page is opened); send the notification to the bell **and by email** to the admins; keep the debounce so it does not repeat | M | Me |
| B3 | ✅ **Done 2026-10-28** (above/below defaults for all 8 types at ±5% of the DA price, plus daily-move and forecast-move defaults; editable, deletable, extendable). **Default alerts per price:** ready on a fresh install, for **all 8 rice types**: (1) daily change of ₱1.00 or more, (2) forecast move of ₱1.50 or more or 3% in 3 days, (3) price above or below its 90-day band. Admins can still add, edit, or switch off rules. **Confirm these thresholds with DA** | M | Me, Team confirms |
| B4 | **Email setup for alerts:** a Gmail app password in the local `.env` (never in the project files or chat); list the admin recipients in Settings | S | Team |
| B5 | ✅ **Done 2026-10-27** (footer on every public page + Admin → Data Sources: DA-AMAS Daily Price Index NCR, PSA for Jan 2015 – Sep 2018, and the 29 covered markets read from the newest bulletin by `tools/da_markets.py`; team still checks the names against the PDF). **Data source and market:** show the source on every page (DA-AMAS Daily Price Index, NCR; PSA for 2015 – Sep 2018). **Market names:** read the list of markets from a recent DA bulletin, show it, and check it against the PDF | S + M | Me, Team verifies |
| B6 | ✅ **Done 2026-10-14 (admin 3-Day Price Forecast card).** **Method indicator** on the next-day prediction: "Adaptive ensemble · biggest weight today: ARIMA 46% · typical error ₱0.28 (MAPE 0.6%)". Say "biggest weight today", not "best method" | M | Me |
| B7 | ✅ **Done 2026-10-27** (shared footer from `public/js/public-shell.js` + `public/css/site-footer.css`: DA, DOE, PSA, World Bank, ExchangeRate-API with logos; "Last updated" from `GET /api/site-status`; contact agripriceph@gmail.com). **Footer on every public page:** sources and "last updated" | S | Me |
| B8 | ✅ **Done 2026-10-27** (each price card shows "DA · Oct 26" from `/api/predictions` `price_dates`, the newest official DA day per type, never an estimate). **Front page:** the date each price was taken ("as of Oct 8, 2026 · DA bulletin"), per rice type; an estimated row is never shown as official | S | Me |
| B9 | ✅ **Done 2026-10-27** (`js/forecast-narrative.js`, under the public and admin forecast graphs). **Price Forecast narrative:** a short automatic summary under the graph (public and admin), built from the numbers | M | Me |
| B10 | ✅ **Done 2026-10-27** (home page: 4-step degree-of-milling slider + PNS grades table + "DA categories are market categories" note, linked to the PNS). **PNS grain image:** split it into (a) a degree-of-milling slider (undermilled / regular / well-milled, from the PNS) and (b) a table of PNS grades (Premium, Grade 1 to 5); label the DA price categories as market categories, not PNS grades; link [PNS/BAFS 290:2025](https://bafs.da.gov.ph/wp-content/uploads/2025/12/PNS-BAFS-290-2025-Paddy-and-Milled-Rice-%E2%80%94-Product-Standard-%E2%80%94-Grading-and-Classification-1.pdf) | M | Me |

---

## C. IT Expert

| # | Task | Size | Who |
|---|---|---|---|
| C1 | Fix the **TensorFlow retracing warning** (batch the repeated `model.predict` calls in the scoring loops) | S | Me |
| C2 | Harden **SQLite**: a `busy_timeout` and an explicit WAL setting on every connection (it is already in WAL mode) | S | Me |
| C3 | Use a **production server** (waitress) instead of the Flask development server; update `run_backend.bat` | S | Me |
| C4 | Write into the paper's limitations and future work: single-site design; **Celery + PostgreSQL** if it grows to many users or servers | S | Me edits, Team reviews |
| C5 | Write down the reply to the evaluator: training already runs as a separate process; the manual review is a deliberate data-quality control; the database is in WAL mode (suggested wording is in my earlier message) | S | Team |

---

## D. Still open from earlier work

| # | Task | Size | Who |
|---|---|---|---|
| D1 | **Paper and docs** for the new factors: `PAPER_CORRECTIONS.md`, `CLAUDE.md`, `SYSTEM_GUIDE.txt`, `SYSTEM_FEATURES.md`, and the `.docx`. Chapter 3: remove gasoline and the lag/rolling features, add core inflation (PSA) and world rice (World Bank), fertilizer considered and left out. Chapter 4: new numbers. Add the **LSTM finding** (the network ignored its inputs; two fixes tested and rejected) | L | Me |
| D2 | **References:** PSA OpenSTAT, DA price-monitoring archive, World Bank Pink Sheet, PNS/BAFS 290:2025 | S | Team |
| D3 | Re-measure the **price-range coverage** (`cd model && py -3.13 experiments/interval_coverage_ensemble.py`); the "about 90%" in the AVP depends on it | S | Me |
| D4 | ✅ **Done 2026-10-28** (stock, rainfall, month calculated per rice type with p-values; tariff labelled "not calculated" while the schedule has one rate). **Market Drivers:** Rainfall, Month, and Import Tariff show fixed numbers set in the code, not calculated from data. Calculate them or label them "reference" | M | Me |
| D5 | Paper's sprint evidence (red notes in the `.docx`): total sprints, duration, backlog or board screenshots | S | Team |
| D6 | Nothing is **committed** yet. Commit when you are ready, after the work above | S | You |

---

## E. Video (AVP)

| # | Task | Who |
|---|---|---|
| E1 | Finish the **quick script** (add the forecast-vs-actual scene), then the **visual guide** | Me |
| E2 | Generate the audio in Google AI Studio (voice, Scene, Sample Context, 9+ speech blocks) | Team |
| E3 | Record the screen clips (restart the backend, one full scrape, Super Admin account, a public test account, a pre-recorded training run) | Team |
| E4 | Edit: audio first, clips under it, overlays, captions; check 2:30 – 3:00 and that every number matches | Team |

---

## Suggested order

1. **Phase 1, quick wins (about a day):** B1, B5 (sources), B7, B8, C1, C2, C3.
2. **Phase 2, the big items:** A1 (new module) with the price-only models, then B2 + B3 (alerts), B6, B9, B10.
3. **Phase 3, finishing:** D1 to D5, A2 (market survey, which the team can start **now**, in parallel), E1 to E4.

## Questions to settle

1. **A2:** DA retail price only, or also your own market survey? (Starting the survey early costs nothing.)
2. **A1:** are you comfortable presenting that the factors do not change the short-term forecast, as the honest result?
3. **B3:** do the three default alert thresholds look right for DA, or should they be different?

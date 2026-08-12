# AgriPrice — Corrections for the Capstone Writeup

Generated from an audit of the **running code** against `AgriPrice_Draft_Revised.docx`.
These are places where the paper should be edited to match what the system actually does
(the code has been left as-is for these items, or already changed where noted). Each entry
cites the code that is the source of truth.

> After this audit, the code was also changed for several items (LSTM now serves live
> forecasts, 70/15/15 split, naive-persistence baseline + ADF, 3-day horizon, and
> lag/rolling/seasonality features). Those are **already true in the code** — see the
> "Now true in code" section at the bottom so your paper claims are safe to defend.

---

## Edit these paragraphs in the paper

### 1. Feature set — list the real inputs (Purpose & Description, Conceptual Framework, Algorithm)
The paper lists four inputs: rice price, USD-PHP exchange, weekly diesel, and an
agricultural seasonality index. The model actually trains on **more** exogenous drivers.
Per-target feature vector (`model/data_pipeline.py`, `model/meta.json`):

- target rice price, **RON-95 gasoline price**, **diesel price**, **rice-stock inventory
  (metric tons)**, **farmgate price**, **USD-PHP exchange rate**
- plus engineered features now added: seasonality (sin/cos month), 7-day rolling averages
  of diesel & exchange, and target price lags (1-day, 7-day) + 7-day rolling mean.

**Action:** update the writeup to name rice-stock inventory, farmgate price, and gasoline
alongside diesel and exchange rate. This *strengthens* the "multivariate" argument — do not
hide these inputs.

### 2. Diesel data source — not the DOE portal (Framework, Data Ingestion Module)
The paper says weekly diesel pump prices come from the **DOE portal**. The scraper actually
pulls fuel prices from **Zigwheels** (`tools/scrap.py`: `FUEL_URL = "https://www.zigwheels.ph/fuel-price"`),
a Manila pump-price aggregator, at the same 24-hour cadence as the other sources.

**Action:** either describe the fuel source accurately (a public Manila fuel-price source),
or disclose Zigwheels as a practical proxy for DOE figures. Drop the "weekly / DOE portal"
wording unless a DOE fetcher is added.

### 3. "AI-assisted PDF extraction" — it is rule-based (RRL, Framework, Implementation)
The DA-AMAS Daily Price Index PDFs are parsed by deterministic table extraction
(`tools/pdfconvrt.py` via `pdfplumber`), not an AI/ML model.

**Action:** change "AI-assisted PDF extraction" to "**rule-based / layout-aware PDF
table extraction**." This is accurate and still defensible. (Only keep "AI-assisted" if you
actually add an LLM/vision extraction step.)

### 4. Security & Data Handling — the hardcoded API key does not exist (Research Ethics)
The paper flags a hardcoded financial API key as pre-deployment debt. The exchange-rate
endpoint used (`tools/scrap.py`: `https://open.er-api.com/v6/latest/USD`) is **keyless** —
there is no API key in the code to migrate.

**Action:** correct the subsection to state the exchange API requires no key. Describe the
admin auth accurately: server-issued session tokens, password **and** 6-digit access code
stored as **hashes** (`model/admin_auth.py`, `model/settings_store.py`), 5-attempt / 15-min
lockout. For the RA 10173 sentence: the system keeps client IP + created-time **in memory
only** for the active admin session and does **not persist/log user IP addresses**.

### 5. Dashboard is responsive, not desktop-only (Purpose, Objective 6.4, System Design)
The public site includes 109 responsive breakpoints across 13 files
(`public/**/*.css`, `public/*.html`), so it renders on mobile and desktop.

**Action:** reverse the "desktop-only" scoping to "**desktop and mobile browsers**."
Update Objective 6.4 (Compatibility) accordingly. This is a strength, not a limitation.

### 6. Scope & Limitations — weather is genuinely excluded (verify wording)
The paper's Scope says the system does not use weather/rainfall. Confirmed: the current model
does **not** use any weather/rainfall feature (an old `weather_data` table exists in the DB
but is not in the feature set). This is consistent — no change needed, just don't reintroduce
rainfall as a feature without updating the Scope.

---

## Now true in code (safe to keep as written / strengthen)

- **LSTM produces the live forecast.** The dashboard forecast is served by the per-type LSTM
  models via `/api/predictions` (`model/predict.py`). A previous heuristic "2026 formula" path
  was demoted to an explicit, off-by-default fallback (`AGRIPRICE_FORMULA_MODE`). You can state
  plainly that the LSTM generates the displayed forecasts.
- **Chronological 70/15/15 split, no leakage.** `model/train.py` splits sequences 70/15/15 in
  time order, fits the scaler on **train rows only**, and uses the middle 15% as a true
  validation set (early stopping) with the final 15% held out for reporting. The paper's
  MANDATORY chronological-split requirement is satisfied.
- **Naive-persistence baseline + ADF.** Every rice type now reports LSTM MAE/RMSE **and** a
  naive-persistence baseline MAE/RMSE, a `beats_baseline` flag, an ADF p-value, an
  **ARIMA(1,1,1) baseline**, and a **shock-day comparison** (`model/meta.json`, all visible in
  Admin → Metrics). Cite these numbers in the Statistical Treatment / Testing chapters.

  ⚠️ **IMPORTANT — how to frame the result honestly (defense-critical).**
  On the held-out test set (clean chronological split), for **Local Well-Milled**:

  | Model | MAE (₱/kg, all test days) |
  |---|---|
  | Multivariate LSTM (anchored-delta) | 0.247 |
  | Naive persistence | 0.229 |
  | ARIMA(1,1,1) | 0.229 |

  All 8 types look the same: **LSTM ≈ persistence ≈ ARIMA** (LSTM within ₱0.003–0.03).
  ARIMA(1,1,1) collapses to persistence here because the series is a near random walk
  (ADF p ≈ 0.07 → cannot reject a unit root). A **shock-day analysis** (top-10% most volatile
  test days, where price moved ≥ ₱1.0 from the last value) was run specifically to look for LSTM
  advantage where it should matter most: the LSTM beat persistence on only **2/8** types and by
  a trivial margin (₱0.001–0.003). So the LSTM does **not** reliably win even during volatility.

  **Defensible framing (do this):**
  1. Report LSTM, persistence, AND ARIMA side by side — all three tie. (Numbers are in Admin →
     Metrics and `model/meta.json`.)
  2. State the honest conclusion: at a 1–3 day horizon, NCR rice retail prices are effectively a
     random walk, so no model — classical or deep — meaningfully beats "tomorrow ≈ today." This
     is itself a **valid empirical finding** and matches the efficient-short-horizon literature.
  3. The LSTM's contribution is a **unified multivariate system**: one pipeline forecasting all
     8 rice types while incorporating fuel, FX, stock, farmgate, and seasonality — matching
     classical baselines' accuracy, not a claim of beating them.
  4. Frame accuracy superiority as **future work** (longer horizons where drivers matter; explicit
     shock/anomaly features; GARCH for volatility).
  5. Note the earlier ₱0.47 figure was inflated by test-into-validation leakage.
  **Do NOT** claim the LSTM outperforms the baselines — the data does not support it and a
  technical panel will check.
- **48–72 hour (3-day) horizon.** `HORIZON = 3` (`model/data_pipeline.py`); the API and both
  dashboards now show Day 1/2/3. Matches the "48–72 hour / 2–3 day" claim.
- **Feature engineering (lag + rolling + seasonality).** Implemented in
  `data_pipeline.add_engineered_features()` and used by both training and inference. The
  Conceptual Framework's "lag variables and rolling averages" claim is now real.

## Still needs YOUR team's input (unchanged by this audit)
- Per-stratum UAT headcounts (household / vendor / IT / DA-AMAS) — paper blanks.
- Sprint count/duration and backlog screenshots.
- Synthesis Matrix rows + at least one counter-evidence study (DL not beating a baseline) — your
  own results are now a concrete example of this.
- "Rockets and feathers": current lag features are symmetric. If you want to *model* the
  asymmetry (not just cite it), add separate rising/falling diesel & FX lag features; otherwise
  note it as a limitation.

---

# Defense Round 2 — DTI categories, brackets, taxes, ANOVA, Slovin (in progress)

Panel feedback #1–7. Scope decisions: survey/ANOVA done **offline + documented**; price brackets
are **data/display only** (model still forecasts a point); keep the **8 categories**, add brand/
market/bracket/tax as new dimensions. **Do not invent DTI/BOC/BIR data — [VERIFY] flags below.**

## Now true in code (cite these)
- **Sampling — Slovin (e=0.05).** `research/stats.py` implements `n = N/(1+N·e²)`. Key figures:
  **N=100 → n=80**, N=120 → 92, N=150 → 109, N=200 → 134. So a defined population of **N≈100**
  justifies the panel's **≥80** minimum. Run `py -3.13 research/stats.py --slovin 100`.
- **One-Way ANOVA.** `research/stats.py one_way_anova()` compares mean evaluation scores across
  respondent groups (Households, Distributors, IT, DTI); H₀: all group means equal, H₁: at least
  one differs; α=0.05; includes Levene/Shapiro checks + Tukey HSD (falls back to Welch/Kruskal
  guidance if assumptions fail). Feed it your Google-Forms responses CSV.
- **Accuracy metrics expanded.** `model/train.py` now records per type (in `model/meta.json`,
  shown in Admin → Metrics): **MAPE** and **R²** on top of MAE/RMSE, plus a **rolling-origin
  evaluation** (MAE across 5 chronological blocks of the held-out test, mean±std) — alongside the
  existing naive-persistence + ARIMA + ADF + shock analysis. Current WM: MAE ≈ ₱0.24, MAPE ≈ 0.5%,
  R² ≈ 0.99. ⚠️ **R² caveat:** it's high because prices trend and the model tracks the level;
  persistence scores similarly, so keep **MAE-vs-persistence** as the value argument, not R².
- **Rice catalog schema.** `datasets/catalog_schema.py` adds `dti_category` (8 seeded, mapped to
  model keys), `rice_brand`, `market`, `rice_price_bracket` (min–max, `CHECK(min≤max)`), and
  `tax_component`. Additive/non-breaking; the ML time series is untouched.

## Paper edits still to write (Chapter 3)
- Replace weighted-mean-only treatment with **One-Way ANOVA** (state H₀/H₁, α=0.05, post-hoc).
  Keep weighted mean + SD as descriptive stats.
- Add the **Slovin** subsection with the derivation and the N→n table; state your real N.
- Rewrite **Population & Sampling** for the 4 groups incl. **DTI personnel** (replaces DA-AMAS);
  recommended allocation summing to 80: Households 30 / Distributors 25 / IT 15 / DTI 10.
- Add **MAPE/R²** (and rolling-origin evaluation) to the accuracy-testing section.
- Add **price brackets** (prices reported as ₱min–₱max) and an **imported-rice tax/import-charge**
  subsection to Scope + Data.

## Verified sources found (2026-08-10) — now seeded with citations
- **Import tariff (imported rice): 15%**, price-indexed 15–35% under **EO 105 s.2025** & DA
  Circular 2025-001 (15% for Jan–Mar 2026); reduced from **RA 11203**'s 35% by **EO 62 s.2024**.
  Sources: USDA FAS RP2026-0004; USDA FAS "EO 62 Modifying Import Duty Rates". Seeded in
  `tax_component` (verified=1).
- **VAT: rice is VAT-EXEMPT** — agricultural food product in original state (**NIRC §109**). So
  **no 12% VAT** on rice; seeded as a 0% component with the exemption note. (Corrects the earlier
  assumption that VAT applies.)
- **Price brackets:** DA **Bantay Presyo** publishes prevailing retail **ranges** per category
  (e.g., imported well-milled ₱46–62). Seeded 3 ranges in `rice_price_bracket` (source cited);
  refresh from the official DA daily sheets.
- **Brands:** DA / DA-AMAS monitor rice **by category and price range, NOT by brand** — so brands
  cannot be sourced from DA/DA-AMAS. Brand membership per category still needs **DTI**. No brands
  invented.

## Implemented this round (catalog/taxes split + correlation)
- **Public Rice Catalog** (`public/rice-catalog.html`) — NCR-only, 8 category **tabs** driving ONE
  reusable table (Brand | Price | Actual Package | Location | Source | Last Update). Price is
  pulled from the forecast (DA bracket range / latest forecast price), never stored per brand.
  Verified NCR products seeded with cited sources: **Doña Maria Jasponica & Miponica 5kg**
  (Local Premium, SL Agritech official) and **Royal Umbrella Thai Hom Mali 5kg** (Imported
  Premium, NCR retailer). Categories with no verified product show the empty state — consistent
  with DA's 2018 rule that milled rice is sold by classification, not brand. `rice_brand` schema
  extended (package/location/source_url/last_verified/classification_note).
- **Admin "Taxes & Import Charges"** (`admin/pages/taxes.html`): import charges (admin-only) +
  consumer-price preview (base + tariff; local rice gets no tariff; VAT 0%).
- **Correlation analysis:** added **Import Tariff** as an imported-rice factor. Computed raw Pearson
  r vs imported well-milled price (2019–2026) = **−0.03 (negligible)** — a policy step-variable
  confounded by global prices/FX; included as a contextual cost factor, not a linear predictor.

## Dynamic import tariff (effective-date, source-verified, staleness-aware)
- **Finding (verified):** the rice import tariff is **not fixed at 15%**. Under **EO 105 s.2025** +
  **IAGRTA Circular No. 2025-001** (eff. Jan 1, 2026) it is a **quarterly, price-indexed MFN rate
  bounded to 15%–35%**, indexed to the **Vietnam 5%-broken FOB price (UN-FAO)** vs a **March-2025
  baseline**, moving ±5 percentage points per 5% price move. Each quarter the **DA issues a
  certification** (posted on da.gov.ph) and **BOC issues a Customs Memorandum Order**. **Q1 2026 =
  15%** (increase trigger not breached). Sources: USDA FAS RP2026-0004 (Feb 2026); EO 105
  (SC E-Library); PCO/PIA; IAGRTA Circular 2025-001.
- **No official API / machine-readable feed exists** — the binding rate is published only as DA
  certifications and BOC CMOs. Auto-scraping was rejected (same fragility as the price scraper).
- **Implementation:** new dated **`tariff_schedule`** table (rate, effective_start/end, quarter,
  legal_basis, DA certification URL, verified, approved_by/at) + **`tariff_audit`** log +
  **`tariff_config`** (FAO baseline, left **unset** — not fabricated). `consumer_price()` and
  `list_taxes()` now select the tariff row **applicable to the query date**; the legacy single
  `tax_component` tariff row is retired (avoids double-count). New endpoints `/api/tariff` (GET),
  `/api/tariff` (POST, admin-guarded), `/api/tariff/indicative` (GET, FAO decision aid),
  `/api/tariff/audit` (GET, admin). Admin **Taxes** page shows the current rate, a **staleness
  banner**, the full schedule, an **add-quarter form**, and the FAO indicative helper.
- **Staleness behavior (honest):** today (Aug 2026 = Q3) has **no confirmed rate**, so the app shows
  the **last confirmed 15% flagged "unconfirmed for current quarter — pending DA certification"** —
  it never silently rolls a past rate forward or invents a number. Adding the confirmed Q3 rate via
  the admin form clears the flag automatically. VAT stays a fixed **0%** (rice VAT-exempt, NIRC §109).
- **[ACTION quarterly]** when the DA posts each quarter's certification, admin adds the rate + CMO
  link on the Taxes page. **[VERIFY]** set the March-2025 FAO baseline to enable the indicative helper.

## UI feedback round: signup / settings / logs / scraper
- **Public accounts** are **localStorage-only** (`agriprice_public_users`) — no users table, no
  backend signup/role validation. If the paper implies server-side user accounts/roles, correct it.
- **Signup role simplified:** removed **Household**; **Vendor → Retailer** (single implicit role;
  no picker). Legacy vendor/household sessions are normalized to `retailer` at login. If the survey
  methodology names "vendors"/"households" as user types, align the app-facing term to **Retailer**
  (the households remain a *guest* audience; the stats view still has a vendor/household data lens).
- **Public Settings** is now **logged-in only** (guest nav hides it; direct-URL access redirects)
  and trimmed to **Account + Appearance** (removed Data Connection, Privacy & Storage, About,
  Preferences — all were client-side only).
- **System Logs** was a **static mock**; now serves the **real backend log buffer** via a new
  admin-guarded `GET /api/logs` (+ `POST /api/logs/clear`), with auth-login events recorded. It is
  **in-memory (resets on restart)** — state that honestly if the paper describes persistent logs.
- **Web Scraper:** removed the "Live Scraped Data Preview" table (display only); scraping, storage
  (`WS_*`/CSV), status, stats, and the activity log are unchanged.

## Still [VERIFY] / [ACTION]
- **[DTI]** confirm the 8 category names/definitions and the **brands** under each (DA has none).
- **[DTI]** whether to keep the DA Bantay Presyo ranges or use official DTI brackets.
- **[BOC]** any additional customs processing fees beyond the tariff.
- **[ACTION]** state the target **population N** (≈100 to justify n=80).

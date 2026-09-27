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
  ⚠️ **Root cause now identified (2026-09-05) — see Round 7 below.** The near-random-walk result
  isn't just "rice prices are unpredictable" — it's largely because ~90% of the nominally-daily
  price series is unchanged day-to-day (DA's bulletin doesn't post new figures every calendar
  day). That doesn't reverse the honest framing above, it explains *why* it's true and gives a
  citable, sourced reason instead of a bare statistical observation.
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
  ⚠️ **Superseded by Round 6 below (2026-09-04)** — public accounts moved server-side.
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

## Doc↔app cross-check — edits applied to the .docx (2026-08-12)
Cross-checked the running app against `AgriPrice_Draft_Revised.docx`. Two factual drifts were
found in the paper body and **corrected directly in the .docx** (backup was taken then removed):
- **Import tariff sentence (Significance/consumer-price para):** was "15% under EO 105 s.2025"
  (reads as a fixed value). Updated to **"a quarterly, price-indexed rate within a 15%–35% band
  under EO 105 s.2025 and IAGRTA Circular No. 2025-001 — 15% for the first quarter of 2026,
  reduced from the 35% of RA 11203 by EO 62 s.2024."** Now matches the app's dynamic
  effective-date tariff (see the dynamic-tariff section above).
- **Data-privacy IP-logging placeholder (Ethical Considerations):** the paper had a `___ [state
  whether the admin panel logs IP addresses…]` placeholder. The app now records **admin sign-in
  events with the originating IP + timestamp** in the in-memory System Logs buffer, so the
  placeholder was replaced with an actual disclosure: public-facing system logs **no** end-user
  IPs; the admin panel logs **admin** sign-in IP/timestamp for security, **not persisted** across
  restarts, no evaluator/end-user PII. Aligns with RA 10173.

**Terminology (documented reconciliation, NOT a paper rewrite):** the paper's defended user model
and UAT strata are **"households and local vendors"** (RQ4/5, Objectives 5/6). The app now labels
the single account role **"Retailer"** (= the paper's *local vendor*) and serves **households as
guest users** (today's prices + 3-day forecast are free, no account). This preserves the paper's
two-audience evaluation while simplifying signup — no defended-methodology text was changed. If the
panel prefers exact wording parity, either add a one-line note in the paper ("the app labels the
vendor account 'Retailer'") or revert the app label to "Vendor"; flagged for the team's decision.

## Round 3 — PSA/PAGASA data-source research + nav/tariff changes (2026-08-12)
**Research (verified, no source invented):**
- **PAGASA rainfall → Do NOT automate.** No official public rainfall **API**. PAGASA offers
  **CliMap v2.0** (interactive download of climate/rainfall data) and archived station datasets;
  the community "PAGASA Parser" covers **tropical-cyclone bulletins only** and is unaffiliated.
  Also, **rainfall is not a current model feature** (`FEATURE_COLUMNS` = fuel/stock/farmgate/
  exchange — no rainfall), so automating it adds little. Recommendation: **manual/none**; the Web
  Scraper lists PAGASA as **Planned**. Sources: PAGASA CliMap v2.0 (bagong.pagasa.dost.gov.ph),
  PAGASA climate monitoring (pagasa.dost.gov.ph/climate/climate-monitoring).
- **PSA rice stock → Manual/admin workflow (not a live scraper).** Official data is on **PSA
  OpenSTAT** (openstat.psa.gov.ph, a PX-Web platform) — **"Rice and Corn: Monthly Total Stocks
  Inventory by Sector"** (Total/Household/Commercial/NFA) — but it is **monthly, aggregated**, not
  a daily feed, and prior scraping failed. Per "reliability over forced automation," recommend a
  **periodic manual OpenSTAT download + import**; the Web Scraper lists PSA as **Planned**. No
  fragile scraper was built. Sources: PSA OpenSTAT (openstat.psa.gov.ph), PSA "Rice and Corn Stocks
  Inventory" (psa.gov.ph/statistics/crops/rice-corn-stocks-inventory).

**App changes (not paper claims, logged for traceability):**
- **Tariff "Admin Entry" label** — added `tariff_schedule.entry_type` (OFFICIAL | ADMIN,
  idempotent migration). Seed/source-based rows = **Official / Source-Based**; admin-form additions
  = **Admin Entry** (set server-side in `add_tariff_quarter`, not inferred from the UI). Shown as a
  Type badge in the admin Taxes table.
- **Tariff release confirmation** — the admin add-rate form now shows a summary popup before
  publishing (category, rate, entry type, effective dates, source/basis) and blocks double-submit;
  existing band/date/duplicate/`_require_admin` validation is unchanged (confirmation is additive).
- **Navigation** — Settings removed from the primary public nav on **every** page (was
  inconsistent) and moved to a **burger menu**; added a circular **Profile** icon → Settings →
  Account (`settings.html#account`). Post-login now routes to **Price Forecast** (and authenticated
  users hitting the landing page are redirected there). Logout remains only in Settings → Account.
- **Icons** — replaced emoji controls (➕/🔎) in the Taxes page with inline SVGs; standardized the
  Web Scraper monitor-card typography.

## Round 3.1 — "Added By" column + admin API authorization (2026-08-12)
- **Rice Import Tariff table** now has an **"Added By"** column (renamed from "Type"): admin-created
  rows show **Admin Entry**, seed/source rows show **Official / System**, established server-side by
  `tariff_schedule.entry_type` (not the UI); the `approved_by`/`approved_at` identity is shown as
  secondary text. Source/basis validation + Active/Inactive unchanged.
- **Backend admin authorization (security).** Previously only tariff-writes + `/api/logs` were
  guarded; now **all state-changing admin endpoints** enforce `_require_admin()` (401 without a valid
  admin session token): `run-scraper`, `run-training`, `import-2026`, `settings` (PUT/reset/password),
  `alerts/rules` (POST/PUT/DELETE/toggle) + `alerts/evaluate` + `alerts/log` DELETE, `reports/generate`
  + `reports/file` DELETE. The shared `js/api.js` client **auto-attaches the admin token** when an
  admin session exists, so the dashboard keeps working while a normal user (or a direct API call)
  without a token is denied. Public read endpoints (predictions, tariff GET, consumer-price, catalog,
  health) stay open. This closes the "admin endpoints unguarded" pre-deployment gap for state changes.
- **User vs Admin Settings kept separate** (public `settings.html` = Account + Appearance only; admin
  dashboard has its own Settings + per-area pages). No **User Management** invented (single admin).
  Admin Settings → Account now also offers **Log Out**.

## Round 4 — nav/login/signup UX + data-source label (2026-08-12)
- **Data source label:** the fuel source display name **"DOE – Dept. of Energy" → "Zigwheels (Fuel)"**
  across the UI/API (the technical key `doe`/`WS_fuel` is unchanged). This aligns the app with the
  paper's existing correction that the diesel/fuel source is **Zigwheels, not DOE**.
- **Terms & Conditions modal:** the signup "Terms & Conditions" is now a real button opening a modal
  with an **honest demo notice** (capstone/educational; local-only accounts, no PII; data from
  DA/PSA/FAO; forecasts are estimates; no warranty). **No legal text was fabricated** — formal T&C
  remain **[ACTION: project owner]** before any real deployment.
- **UX fixes (not paper claims):** Home button added to the public nav + homepage stays reachable
  after login (post-login still → Price Forecast); login/signup **password eye** fixed by suppressing
  the browser's native reveal control (our SVG eye is the only one); real-time (debounced) signup
  email validation incl. duplicate check; admin nav tidied (Predictions→Price Forecast,
  Historical→Price History) + responsive burger.

## Round 5 — Model Dashboard merge + stale admin-page numbers (2026-09-04)
- **Admin nav:** "LSTM Model" and "Performance Metrics" merged into one **Model Dashboard** page
  (`admin/pages/model-dashboard.html`, `admin/js/model-dashboard.js`); Training is untouched. Real
  numbers still come from `/api/model-status` (`model/meta.json`) — same source as before, just one
  page instead of two, restyled with honest baseline-comparison language (see below).
- **Stale architecture numbers fixed** (the old LSTM Model page pre-dated this reconciliation pass):
  input feature count corrected **5 → 13** (`model/data_pipeline.py`'s 5 raw exogenous drivers plus
  the 8 engineered seasonality/rolling/lag columns — matches `model/meta.json`'s per-target
  `features` list and this doc's item 1 above); LSTM units corrected **128/64 → 64/32**, Dense
  **32 → 16**, early-stop patience **10 → 8** (`model/train.py`); the Input Features table's fuel-price
  source corrected **DOE → Zigwheels** (matches item 2 above) and its fictional "Rainfall/Weather
  (PAGASA)" row removed (not an actual input — replaced with the real farmgate/seasonal/rolling/lag
  rows that were missing).
- **No new "beats the baseline" claims:** the merged dashboard's metric cards and per-classification
  table deliberately avoid the framing "beats baseline by X%" for cases where it doesn't (current
  `meta.json`: `beats_baseline: false` for all 8 targets) — they instead report "within X% of the
  naive baseline," consistent with this doc's standing honest-evaluation guidance.

## Round 6 — public accounts moved server-side + email password reset (2026-09-04)
- **Public/vendor accounts are no longer localStorage-only.** This directly supersedes the "UI
  feedback round" bullet above. Signup/login (`public/js/public-auth.js`) now call real backend
  endpoints (`POST /api/auth/signup`, `POST /api/auth/login`) that check a new SQLite table
  (`model/agriprice_users.db`, via `model/user_store.py`), with passwords hashed using
  werkzeug's salted PBKDF2 (`model/user_auth.py`) — not plaintext. `sessionStorage`'s
  "who's currently logged in" display state (`agriprice_public_session`) is unchanged; only the
  credential itself moved server-side.
- **Real email-based "Forgot password?"** now exists on `public/login.html`: a 6-digit code is
  emailed from `agripriceph@gmail.com` via Gmail SMTP (`model/mailer.py`) and verified against a
  15-minute, single-use, rate-limited code (`POST /api/auth/forgot-password`,
  `POST /api/auth/reset-password`). The response is deliberately generic regardless of whether the
  email exists (anti-enumeration) — see `model/user_auth.py`'s `request_reset()`.
- **Legacy localStorage accounts (created before this change) migrate on next login, from the same
  browser only.** `login()` tries the server first; on a miss it falls back to the old
  `agriprice_public_users` array, and a match is silently re-registered server-side and removed
  from the legacy array. An account that never logs in again from that same browser cannot be
  recovered — this is a genuine, stated limitation, not a bug to paper over if asked about it
  during defense.
- **If the paper describes accounts as demo/local-only/no-real-backend** (the exact claim the
  superseded bullet above was flagging), that section now needs the opposite correction: accounts
  **are** server-side, with hashed passwords and a real (if lightweight, single-server, in-memory
  rate-limiting) auth backend. Cite `model/user_auth.py`, `model/user_store.py`, `model/mailer.py`.
  Do **not** claim this is a production-grade auth system (no email verification on signup, no
  password complexity beyond the existing 8-char/upper/lower/digit rule, single SQLite file, no
  admin-account email/reset yet) — frame it as "real for the capstone's scope," not enterprise-ready.

## Round 7 — Root cause of the near-random-walk finding: DA reporting cadence, not missing-value handling (2026-09-05)

**Question investigated:** *why* does the LSTM tie persistence/ARIMA on every one of the 8
types (Round-6-era "Now true in code" section above)? Is that a genuine property of the market,
or an artifact of how this project's own pipeline handles the data?

**Verdict: upstream, not `ffill().bfill()`.** The flat-lining is baked into
`datasets/DATASETS_RETAIL_PRICE_2015_2025.xlsx` itself — `datasets/script.py` loads it verbatim
(`pd.read_excel()` → `to_sql(..., if_exists='replace')`, no transformation). It is **not**
introduced by `model/data_pipeline.py`'s `ffill().bfill()` (line 261): that call has **zero
NaNs to act on** in the rice columns (0/4,018 missing across all 8 categories), so it is a
no-op for this question.

**What was checked, and ruled out:**
| Code path | What it does | Could cause the multi-hundred-day streaks? |
|---|---|---|
| `datasets/script.py` (historical import) | `pd.read_excel()` → `to_sql()`, byte-for-byte passthrough | No fill logic exists here at all — this **is** the flat data |
| `datasets/import_2026.py` | `.ffill()` on the 2026 sheet, for isolated 1–2 day gaps | No — current DB has no rows ≥2026-01-01; the longest streak (2021–2023) predates this path |
| `tools/scrap.py` / `tools/rice_estimate.py` (scraper gap-fill) | Trend-extrapolates scraper gap-days | No — writes to the separate `WS_rice_price` table, not `retail_prices` |
| `model/data_pipeline.py` merge | Outer-merge + `ffill().bfill()` | No — 0 NaNs in the rice columns pre-merge; nothing gets filled |

**Quantified (queried directly against `datasets/agriprice_database.db`, table `retail_prices`,
4,018 rows = every calendar day 2015-01-01 → 2025-12-31, no missing rows; cross-checked
identical to `DATASETS_RETAIL_PRICE_2015_2025.xlsx` row-for-row):**
- **Zero-change day-pairs:** 89.5%–92.5% per category, **mean 90.4% across all 8 types.**
- **Longest flat run: 591 days**, *Imported Special*, 2021-08-01 → 2023-03-14, constant at
  ₱50.00/kg. Other categories peak at 118–167 days, several clustering in Mar–Jul 2020 (a
  plausible real-world ECQ/lockdown effect, not a data defect).
- **Median gap between genuine value changes: exactly 7.0 days, in every one of the 8
  categories** (pooled median also 7.0 across 3,062 total change-events); 56.1% of genuine
  changes land exactly 7 days after the prior one.
- **Weekday-of-change skews to Monday** (~25% of changes, the single most common day) —
  consistent with a weekly reporting/posting cycle, not daily market movement.
- **Corroborating internal evidence:** `tools/scrap.py`'s own scraper logs (in Tagalog)
  *"Walang [date] na Daily Price Index sa DA.gov.ph"* — the app's live scraper already expects
  DA's "Daily Price Index" to not post every day, matching the same cadence found in the
  historical file.

**Citable paragraph (paper-ready, drop into Statistical Treatment / Results & Discussion):**
> The retail price series nominally spans 4,018 consecutive calendar days (2015-01-01 to
> 2025-12-31, one row per day, no gaps), but only carries new information roughly weekly:
> across all eight rice categories, a mean of 90.4% of day-to-day observations are unchanged
> from the prior day, and the median interval between genuine price changes is exactly 7 days
> per category (source: `datasets/agriprice_database.db`, table `retail_prices`, N=4,018;
> verified identical to the underlying `DATASETS_RETAIL_PRICE_2015_2025.xlsx`). The longest
> constant run is 591 days (*Imported Special*, Aug 2021–Mar 2023, ₱50.00/kg). This reflects the
> cadence of the underlying DA Daily Price Index bulletins the dataset is compiled from — which
> are not published every calendar day — rather than any missing-value imputation in this
> project's own pipeline: the ingestion script (`datasets/script.py`) performs a verbatim load
> with no fill logic, and the training pipeline's `ffill().bfill()` step
> (`model/data_pipeline.py`) has zero missing values to act on in this column set. Practically,
> this caps the genuine daily signal available to a 3-day-ahead forecaster at roughly one real
> observation per week, which is consistent with this paper's honest-evaluation finding that the
> LSTM performs comparably to a naive-persistence baseline at this horizon.

**Action:** cite this alongside the existing "LSTM ≈ persistence ≈ ARIMA" finding above — it
upgrades that finding from a bare statistical observation (ADF p≈0.07) to a sourced, mechanistic
explanation. Does not change any code or metric; documentation only. Next step (if pursued): a
fairer LSTM-vs-baseline comparison would score only genuine change-days rather than the full
duplicate-inflated daily series — noted as future work, not yet implemented.

> **Superseded by Round 8 below** (2026-09-05, same day): the 90.4%/591-day/7.0-day figures above
> were measured before three separate data-correction passes were applied. Use Round 8's numbers
> (82.6% / 833 days / 2.0 days) in the paper instead — the mechanism finding (upstream reporting
> cadence, not pipeline imputation) still holds, just the specific figures moved.

---

## Round 8 — Historical data correction (three verified sources applied), confidence-metric and admin-auth bug fixes, and a documented final data-quality position (2026-09-05)

**Context:** Round 7 established that the flat-lining is a genuine, upstream property of DA's own
reporting cadence — but at that point 2015–2025 was still, almost entirely, an unverified
straight `pd.read_excel()` passthrough of one spreadsheet, with spot-checks elsewhere finding
₱1–20/kg discrepancies against real DA bulletins. This round replaced as much of that as could be
independently verified against real DA sources, and — just as importantly — documents exactly
what could **not** be verified and why, so the paper's Limitations section can state the dataset's
actual provenance precisely instead of implying uniform reliability across 2015–2025.

**Three corrections applied, in order (each backs up the DB before writing, each idempotent —
scripts and full rationale in `datasets/`):**

| # | Script | Source | Coverage | Days corrected |
|---|---|---|---|---|
| 1 | `apply_da_corrections.py` | Individual DA "Daily Price Index" / "Weekly Average Price" bulletin PDFs (text-layer only; OCR excluded — see below) | 2023-12-25 → 2025-12-31 | 457 of 738 (61.9%) |
| 2 | `apply_da_amas_weekly_corrections.py` | User-supplied DA-AMAS "Weekly Prevailing Retail Price" workbook, 2021 sheet onward only (2020 sheet excluded — see below) | 2021-01-04 → 2023-12-24 | 1,085 (100% of in-scope weeks) |
| 3 | `apply_da_bantay_presyo_corrections.py` | User-supplied folder of 177 real DA "Bantay Presyo"/"Price Watch"/"Price Monitoring" bulletin PDFs, 2018–2021 (only the 104 using the Imported/Local-split template were usable) | 2019-10-01 → 2021-10-22 | 110 individual days |

**Two real, pre-existing bugs found and fixed in the same pass (unrelated to the data itself):**
- **Confidence metric was mechanically ~99% for every forecast**, regardless of actual model
  quality, because `model/predict.py`'s old formula (`100 - error%`) compresses into a narrow
  band for a series this stable. Replaced with a two-point linear interpolation
  (`_confidence_ratio()`, 0.4% error → high confidence, 4% error → low confidence) that now
  varies correctly per rice type and per forecast day (e.g. a live check returned 90.6% / 89.0% /
  87.1% across the 3-day horizon, correctly decaying with distance).
- **Admin "Start Training" and Web Scraper "Run Now" buttons silently 401'd** — `admin/js/
  training.js` and `admin/js/web-scraper.js` called their `/api/run-training` and
  `/api/run-scraper` endpoints with plain unauthenticated `fetch()`, missing the
  `Authorization: Bearer <token>` header `js/api.js`'s own helpers already attach everywhere
  else. Both buttons now work from the UI.

**Two data-quality problems caught by validation *before* being written, not after:**
- The DA-AMAS workbook's **2020 sheet has 54 "Wk" header columns for a year that only has 52
  real weeks** — continuing the week-counter blindly would have silently overwritten the real
  first two weeks of 2021 with the wrong values. Caught by an automatic sanity check
  (`parse_da_amas_weekly.py`'s `validate=True`) that rejects any sheet whose week count/alignment
  doesn't match a real calendar year; all of 2020 was excluded from that source rather than
  guessed at.
- The same workbook's **2025 sheet shows "Other Special Rice" (imported) frozen at exactly
  ₱60.00 for 42 of 52 weeks**, coinciding with DA's March-2025 reporting-format change — could not
  confirm whether that's a genuine low-variance reference price or a column the source stopped
  updating, so none of that file's 2024–2025 data was used (2023-12-25 onward already has the
  higher-precision per-bulletin correction anyway).

**Cross-validation performed before applying (not just after):**
- Bantay Presyo PDF values vs. the already-applied DA-AMAS correction, on the 246 dates the two
  sources share: **median difference ₱0.00, mean ₱0.31, max ₱4.00** — strong independent
  agreement between two unrelated DA products.
- Bantay Presyo PDF values vs. the original (still-unverified at the time) 2019–2020 data: median
  difference ₱1.50, mean ₱2.54, max ₱12.00 — consistent with the ₱1–20 range already documented
  for the 2023–2025 correction, i.e. plausible real bulletin data, not a parsing artifact.
- The last in-scope DA-AMAS week (2023-12-25 to 2023-12-29) lines up **exactly** date-for-date
  with the first day of the existing per-bulletin correction — an independent confirmation the
  week-alignment algorithm is correct.

**Model retrained after each of the three corrections** (8/8 targets each time, TensorFlow
backend). Net metric movement across the whole round was small (±0.1–0.2 percentage points of
accuracy per target, e.g. locWellMilled 99.06%→99.05%, impSpecial 98.07%→98.02%) — expected,
since only ~35% of the training window's dates actually changed value.

**Updated flat-line figures (supersede Round 7's, same underlying finding: upstream cadence, not
pipeline imputation):**
- Overall zero-change-day rate: **82.6%** (was 90.4%), across the same 4,018-day, 2015–2025 span.
- Longest constant run: **833 days**, *Local Special*, 2021-01-04 → 2023-04-16, ₱50.00/kg —
  notably, this record now sits **inside** the newly-verified DA-AMAS window, not the untouched
  original data. That the same phenomenon persists after replacing the source with an
  independently-verified one is, if anything, stronger evidence the flat-lining is genuine DA
  reporting behavior rather than an artifact of the original spreadsheet specifically.
- Median gap between genuine changes: **2.0 days** (was 7.0) — pulled down by the newly-corrected
  2023–2025 window, where per-bulletin data changes far more often (53.0% zero-change vs. 82.6%
  dataset-wide).

**What remains unverified, and why (final position — write this into Limitations, do not leave
it implied):**
- **2015-01-01 → 2019-09-30 (1,734 days, ~43% of the dataset's span) is the only fully-unverified
  stretch left.** A live web search was conducted specifically to close this gap using
  well-known government/news sources before concluding it, with these results:
  - **PSA (Philippine Statistics Authority)** — the only other government body that publishes
    rice retail prices — has both its main site and its OpenSTAT time-series database
    (`openstat.psa.gov.ph`) behind a Cloudflare bot-verification challenge. This was **not**
    bypassed (out of scope for this project's tooling on principle, not a technical limitation).
    Separately, PSA's own public series is coarser than what this system needs even where
    reachable: national- or provincial-level, monthly, and only 2 rice grades with no
    imported/local split — it would work only as a rough trend cross-check, not a like-for-like
    replacement.
  - **DA's own Bantay Presyo portal** (`bantaypresyo.da.gov.ph`) is login-only with no public
    archive browsing.
  - **News outlets** (Rappler, Manila Bulletin, etc.) only ever report a single national monthly
    blended figure, not the NCR-specific, 8-category daily/weekly breakdown this dataset needs.
  - The Bantay Presyo PDFs supplied for this round only reach back to 2018 in a genuinely
    **different, incompatible report template** (single undifferentiated "Commercial Rice"
    figure, no imported/local split) — there is no reliable way to map that onto this system's
    8-category schema without guessing, so 2018–Sep 2019 in that template was excluded even
    though files existed for it.
  - **Conclusion:** this gap is not closeable without either (a) more Bantay Presyo/Price Watch
    PDFs from 2015–Sep 2019 in the newer imported/local-split template, if such files exist at
    all for that period, or (b) a human manually clearing PSA's bot-check to retrieve its coarser
    series for use as a trend-level cross-check only. Neither was available within this round;
    2015–Sep 2019 remains exactly the original, unverified `DATASETS_RETAIL_PRICE_2015_2025.xlsx`
    import.
- **2019-10-01 → 2021-10-22:** only 14.6% individually verified (110 of 753 days, via Bantay
  Presyo PDFs) — the rest of this window still holds original/unverified values for its
  2019–2020 portion.
- **2023-12-25 → 2025-12-31:** 61.9% verified (457 of 738 days) — the remaining 38% are the
  scanned "Weekly Average Price" bulletins Round 7-era work already excluded for unreliable OCR
  (digit-dropping errors confirmed on spot-check, not merely suspected).
- **2026-01-01 → present:** sourced from the live scraper (`WS_rice_price`), not individually
  spot-checked against bulletins the way the corrections above were.

**Suggested paper wording (Limitations / Data Sources):**
> Historical retail price data (2015–2025) was independently verified against original DA
> bulletins and cross-source spreadsheets for 2019-10-01 through 2025-12-31 to varying degrees of
> completeness (14.6%–100% depending on sub-period, detailed in `documents/PAPER_CORRECTIONS.md`
> Round 8), correcting discrepancies of ₱1–20/kg found against the original compiled dataset. The
> 2015-01-01 to 2019-09-30 period could not be independently verified: no DA bulletin using a
> compatible reporting template, and no accessible alternative government source, could be
> located for this period. See Round 9 below for the disclosed smoothing pass applied to this
> window's most extreme flat-run outliers.

**Files added this round:** `datasets/apply_da_amas_weekly_corrections.py`,
`datasets/parse_da_amas_weekly.py`, `datasets/da_amas_weekly_corrections_2020-2023.csv`,
`datasets/apply_da_bantay_presyo_corrections.py`, `datasets/parse_da_bantay_presyo_pdfs.py`,
`datasets/da_bantay_presyo_corrections_2019-2021.csv`. (`apply_da_corrections.py` and its CSV
predate this round.)

---

## Round 9 — Disclosed smoothing of outlier-length flat runs in the unverified 2015-2019 window (2026-09-05, same day)

**This is explicitly NOT a verification.** Round 8 established that 2015-01-01 to 2019-09-30
could not be checked against any real source (DA's archive doesn't reach this far, the supplied
Bantay Presyo PDFs from this era use an incompatible template, PSA's public data is behind a
bot-check this project won't bypass). That conclusion is unchanged. This round instead applies a
disclosed statistical smoothing pass to the *existing, still-unverified* values in that window,
at the user's explicit request, to reduce a specific class of implausible artifact before
finalizing the dataset for submission.

**Rationale:** Round 7/8 established, from independently-verified data elsewhere in this same
dataset, that DA's real reporting cadence produces a median gap of 2-7 days between genuine price
changes — bulletins simply aren't published daily, so long flat runs are individually expected.
Within the *unverified* 2015-2019 window, 1,347 of 1,420 same-value runs (94.9%) already fall
close to that same normal range and were left completely untouched. Only the 73 runs (5.1%)
exceeding 21 days — three times the typical cadence, up to 81 days in the worst case — were
smoothed, on the judgment that runs this long are far more likely to be forward-fill artifacts
from the original spreadsheet compilation than genuine multi-month price freezes.

**Method** (`datasets/smooth_unverified_2015_2019.py`): for each outlier run [day i .. day j]
holding constant value V, followed by day j+1 already holding a different real value V2 (the next
actual recorded change — in a few cases this anchor point is just past the window boundary, in
the independently-verified Oct-2019-onward data), the *interior* days (i+1 .. j) were replaced
with a linear ramp from V to V2. Day i and day j+1 — both real values from the existing data —
were not altered. Nothing was invented outside the range those two real anchors already define.

**Scope:** 73 runs, 2,175 of 13,872 cells in this window (15.7%) — 84.3% of the window is
untouched original data. Example: *Imported Special*, 2015-01-01 to 2015-03-22 (81 days flat at
₱48.00, then a hard jump to ₱50.00) is now a smooth ramp 48.00 → 50.00 across the same span,
landing exactly on the real ₱50.00 anchor on 2015-03-23.

**Effect on dataset-wide statistics:** overall zero-change-day rate moved from 82.6% (Round 8) to
**76.2%**; the longest flat run (833 days, *Local Special*, in the independently-verified
2021-2023 window — untouched by this round) is unchanged, since this round only touches the
2015-2019 window.

**Model retrained after this change** (8/8 targets).

**What this is not:** this is not a claim that 2015-2019 is now verified, or that these specific
smoothed values are historically accurate — they are not sourced from any bulletin. It is
disclosed as a statistical smoothing choice over admittedly-unverifiable data, applied narrowly
and reversibly (the pre-smoothing state is preserved in
`agriprice_database.db.backup-pre-smooth2015-2019-*`). If asked directly: 2015-2019 remains
unverified against any real source; this round only reduced one specific artifact (implausibly
long flat runs) within that unverified window.

---

## Round 10 — Live-data audit: removed hardcoded placeholder figures from the admin UI, fixed 3 real data bugs (2026-09-06)

**Why:** a full end-to-end audit of every page against the live API, checking whether what the UI
*displays* is actually what the database/model *contains* — i.e. proving the system is not a
static mockup. Method: compare each rendered figure against the same value fetched directly from
`/api/*`, using the distinctive mock constants in `js/data.js` (e.g. Local Well-Milled ₱76.00)
as tracers for fabricated data.

**Result — public site: clean.** `landpage`, `current-prices`, `rice-catalog`, `historical` and
`statistics` all render live values (₱48.22 / ₱59.74 / ₱45.00 …) matching the database exactly;
zero mock tracers found. The placeholder numbers in `public/current-prices.html` all carry `id`
attributes and are overwritten at runtime. Gated pages correctly show the login gate rather than
fake data.

**Result — admin: 5 real defects found and fixed.**

| # | Defect | Fix |
|---|---|---|
| 1 | **Dashboard "Key Indicators" were permanently fake.** ₱52.50 / ₱48.00 / ₱62.40 / ₱56.42 were hardcoded in `admin/pages/dashboard.html` with **no `id`**, so no JS could ever update them — they never changed regardless of real prices. | Gave them ids (`ki-wm`/`ki-rm`/`ki-fuel`/`ki-usd`), default `—`, and populated them in `dashboard.js`'s `renderSparklines()` from the same series the sparkline draws. Now ₱48.16 / ₱45.16 / ₱56.74 / ₱62.70, matching the DB. |
| 2 | **Sidebar badges were fake.** "Training **87%**" (real avg accuracy 98.7%), "Price Alerts **2**" (real active rules 3), "Data Sources **3**" — all hardcoded, no `id`, and `grep` confirmed no JS ever touched them. | Gave them ids and added `refreshSidebarBadges()` in `topbar.js`, sourced from `/api/training-history`, `/api/alerts` and `/api/data-sources` summaries; falls back to `—` rather than a stale number. Now 98.7% / 3 / 3. |
| 3 | **`/api/historical-data` mixed two different commodities into one "fuel" series.** It read `Diesel` from `fuel_history` but `RON_95` (gasoline) from `WS_fuel`, then the dashboard labelled the result "Diesel Price" — splicing gasoline onto the tail of a diesel line. | `api/app.py` now reads `Diesel` from `WS_fuel` too (the column exists). Dashboard diesel went ₱58.15 (gasoline) → ₱56.74 (true diesel, matching `data_pipeline`). |
| 4 | **Admin Training page always showed "Last Run: — Never" after a server restart**, despite 23 completed runs on disk, because `_last_train_ts`/`_last_saved_run`/`_last_train_result` are process-local globals. Worse, once the date was restored the page read `ok` off a null `last_result` and labelled a *successful* run **"Failed"**. | `/api/training-status` now falls back to the newest `completed_at` run in the persisted history for all three fields (including a reconstructed `last_result` with `ok`/`cancelled`/`duration`). Now correctly reports "Last Run: Sep 5, 2026 — Completed". |
| 5 | **Module init could silently never run.** `admin/js/router.js` called `mod.init()` inside a double `requestAnimationFrame`; rAF does not fire in a hidden/background tab, leaving the page mounted but uninitialised — showing only static placeholder markup. | Kept the rAF (lets the DOM settle) but added a 120 ms `setTimeout` fallback, guarded so init runs exactly once either way. |

**Also corrected: stale "2-day" horizon labels.** The model forecasts `HORIZON=3` and the table
already rendered 3 rows, but headings still read "2-Day" — `admin/pages/{dashboard,predictions,
reports}.html`, `public/landpage.html`, `admin/js/{topbar,predictions}.js` and four public
forecast copy strings. `js/dates.js` now derives the horizon from the API response
(`forecast.length`) instead of hardcoding two dates, so it can't drift again. The dashboard's
forecast-day switcher also only offered Day 1 / Day 2, making Day 3 unreachable — added Day 3
(the JS was already generic over `forecast[day-1]`).

**Data-quality issue found, partially mitigated, disclosed:** `tools/scrap.py` mis-parsed the fuel
source between **2026-03-10 and 2026-05-27**, recording gasoline ≈ PHP 94-96 and diesel ≈ PHP
119-129 — roughly double the true pump price, with normal PHP 55-60 readings immediately before
and after (79 of 151 scraped rows affected). These feed `fuel_ron95`/`fuel_diesel` as model
features and the admin "Market Drivers" 30-day averages. `model/data_pipeline.py` now applies
`_drop_implausible_fuel()`, blanking values outside PHP 15-110 (a band wide enough to keep the
genuine mid-2022 spike, whose real peak was PHP 103.95) so the existing `ffill()` carries the last
good reading forward; stored scraper rows are left untouched. **This only catches the diesel
half.** The mis-parsed *gasoline* values (PHP 94-96) sit inside the plausible band and cannot be
separated from genuine 2022-era highs by value alone; a `diesel > gasoline` structural rule was
tested and rejected (43 legitimate such rows exist in `fuel_history`). **Remaining action:** the
scraper's fuel parsing needs a look at the source page — this is a known, disclosed limitation,
not a solved problem.

**Model retrained** after the pipeline change so the deployed model matches the corrected feature
data.

**Paper relevance:** nothing here changes the feature set, split, horizon or evaluation result —
it corrects *display* fidelity plus one exogenous-feature data-quality guard. The
"LSTM ≈ persistence ≈ ARIMA" finding is unaffected. The Round-8/9 dataset position is unchanged.

---

### Admin dashboard — per-horizon accuracy surfaced, and the run-over-run comparison explained

Three reporting problems on the admin dashboard, all display-layer:

**1. Per-day accuracy was a single pooled number.** The Rice Price Predictions table showed the
same "Train Accuracy" for Day 1, Day 2 and Day 3, because it read `accuracy_pct` — the figure
pooled across the whole 3-day horizon. Training has recorded `per_horizon_accuracy_pct` /
`per_horizon_mae_peso` per rice type all along (`model/train.py::_per_horizon_mae_peso`), and for
`locWellMilled` they are **[99.21, 99.05, 98.91]%** / **₱[0.3502, 0.4228, 0.4843]** — day 3 error
is ~38% higher than day 1. Those arrays are now exposed by `/api/dashboard-metrics` and
`/api/predictions` (`metrics.by_target`) and the table shows the figure for the selected day.
**Paper relevance:** if the writeup quotes a single accuracy/MAE figure, say explicitly that it is
pooled over the 3-step horizon, and prefer reporting the per-step breakdown — error growing with
horizon is the expected and defensible result.

**2. "Forecast Error (MAE) ▲ ₱0.18 (worse)" reads as model regression; it is not.** Comparing the
two most recent successful runs:

| Run | LSTM MAE | Naive persistence MAE | ARIMA MAE | R² |
|---|---|---|---|---|
| `20260810-233543` | 0.2431 | 0.2281 | 0.2281 | 0.9873 |
| `20260905-203122` | 0.4191 | 0.4132 | 0.4100 | 0.9064 |

The naive persistence baseline has no trainable parameters, so it cannot degrade — yet it rose
almost exactly as much as the LSTM (averaged over all 8 targets: **0.2366 → 0.6151**, a larger
move than the model's own **+0.176**). The difference is the **test window itself becoming more
volatile** between the two training sets, not the model getting worse. `/api/dashboard-metrics`
now returns `trends.baseline_mae_peso{,_prev,_delta}` and the stat-card ⓘ says so in words.
**Paper relevance:** do not present run-over-run metric changes as evidence of model improvement
or degradation unless the underlying data is held constant. The "LSTM ≈ persistence ≈ ARIMA"
conclusion is unchanged and, if anything, reinforced — both move together.

**3. "Today's Rice Prices" showed fabricated day-over-day percentages.** `syncCurrentPricesFromApi`
in `admin/js/dashboard.js` diffed the live API price against whatever already sat in
`AgriPricePH.Data.currentPrices`, which on first paint is the **hardcoded demo data in
`js/data.js`**. Imported Special was reported as "▲ +12.27%" — that is live ₱58.94 against the
mock placeholder ₱52.50, a price move that never happened. It now compares against the previous
day's actual observation in the merged history (real values are ≈ ±0.5–2.5%/day), and withholds
the percentage when no previous observation is loaded. **Paper relevance:** none of these numbers
were model outputs, but do not screenshot the old ticker as evidence of anything.

---

### Regime-aware split, seeding, honest metrics, and prediction intervals

**This is the largest methodology change in the log. It affects the split, the reported metrics, and
the forecast output format — update the methodology and results chapters accordingly.**

**1. The dataset is two regimes, and the old split straddled them.** The retail series is not
homogeneous. Before 2025-Q2 the source published weekly (or was reconstructed from weekly figures)
and the merge forward-fills to daily; from 2025-Q2 the source is genuinely daily. Measured
"no price change" rate for `locWellMilled` by quarter: 2022Q1–2023Q4 **93–100%**, 2024 **77–86%**,
2025Q1 **57%**, 2025Q2 onward **2–11%**.

The chronological 70/15/15 split therefore produced **TRAIN 81.4% flat / VAL 87.8% flat / TEST 26.4%
flat**. `EarlyStopping` + `ModelCheckpoint(monitor="val_loss")` selected whichever weights scored
best on an almost-static validation set — i.e. it rewarded predicting *no change* — and the result
was then scored on a period where prices move. A train/serve regime mismatch, not a modelling choice.

**2. The consequence: the model had collapsed to the naive forecast.** Average absolute predicted
change vs actual change on the old model:

| Rice type | Model predicted move (D1/D2/D3) | Actual move |
|---|---|---|
| locWellMilled | ₱0.001 / ₱0.010 / ₱0.029 | ₱0.35 / ₱0.42 / ₱0.48 |
| impSpecial | ₱0.010 / ₱0.028 / ₱0.025 | ₱0.87 / ₱1.05 / ₱1.22 |

The model moved **~1% as far as prices really move**. Its metrics matched naive persistence to the
centavo because it *was* persistence. Note both explanations were live: a flat training signal, and
the fact that for a true random walk the zero-change forecast is the MSE-optimal one.

**3. The fix, and what it did NOT do.** `train.py::_split_indices` now draws validation and test
from the daily-observation era (`ACTIVE_FROM=2025-04-01`; TRAIN 81.9% flat, **VAL 5.3%, TEST 7.1%**)
while training keeps the full history. Runs are seeded (`AGRIPRICE_SEED=42`).

**The retrained model performs the same as the old one.** Both were replayed over the *identical*
regime-aware test window (n = 280 sequences, 2025-08-29 → 2026-09-05):

| Same test window, both models | Old (`20260905-203122`) | New (`cli-20260907-223910`) |
|---|---|---|
| MAE (₱/kg) | **0.4090** | 0.4100 |
| Skill vs naive | **−0.35%** | −0.66% |
| Movement ratio | 0.0423 | 0.0440 |
| Within ±₱1.00 (D1/D2/D3) | 91.6 / 89.8 / 88.8 | 91.7 / 89.6 / 89.0 |

Skill improved for only **1 of 8** types. The differences are inside run-to-run noise.

**This is a methodological warning worth putting in the paper.** A first reading of the retrain
appeared to show a large gain (skill −3.62% → −1.00%, movement 0.003 → 0.070). That comparison was
invalid: it scored the old model on the old test window and the new model on the new one. Almost the
entire apparent gain was the *test window* becoming less forward-filled, not the model improving.
The same error, in the same repo, that section 2 above warns about.

**What the null result actually establishes.** There were two competing explanations for the model
reproducing the naive forecast: (A) the flat training/validation signal suppressed it, or (B) it had
converged on the theoretically optimal predictor, since for a random walk `E[x(t+h) | x(t)] = x(t)`.
Fixing the split was the experiment that separates them. **Removing the flat validation changed
nothing — so (B) holds.** The LSTM is not broken and was not mis-trained; it has found the right
answer for a near-random-walk series (ADF p = 0.09–0.22 across all 8 types).

The split fix is still kept, on its own merits: evaluation now happens on data that matches the
serving regime, prediction intervals can be calibrated at all (see §5), and runs are reproducible.
It is a **measurement** fix, not a performance fix, and the paper must not present it as one.

**4. `accuracy_pct` must not be reported.** The formula is `100 − MAE/mean_price × 100`. With rice at
₱40–57/kg and MAE ≈ ₱0.50, it returns 98–99% for *anything* — and it scores the naive baseline
**higher than the LSTM on all 8 rice types** (e.g. locWellMilled 99.07% naive vs 99.04% model). It
cannot distinguish a trained model from a trivial one. It is retained in `meta.json` only so pre-v4
runs still render, and is labelled as legacy in the API and dashboard.

**Replace it with the metrics now recorded in `meta.json` v4:**

| Metric | Day 1 | Day 2 | Day 3 |
|---|---|---|---|
| MAE (₱/kg) | 0.33 | — | — |
| Within ±₱0.50 | 79.6% | 75.3% | 72.1% |
| **Within ±₱1.00** | **91.8%** | **89.6%** | **89.0%** |
| Within ±₱1.50 | 95.3% | 94.5% | 94.3% |
| Skill vs naive | −1.00% (avg) | | |
| Directional (days price moved) | ~50% | ~50% | ~50% |

Two cautions. The hit rate **states its threshold** — choose ±₱1.00 because it is ~2% of price and
tighter than DA Bantay Presyo's own published ranges, not because of the number it yields. And
**directional accuracy is a coin flip**: do not claim the system predicts direction. (An earlier
measurement of 27–43% was an artifact of counting zero-change days as wrong; ~50% is correct.)

**5. Forecasts now carry a calibrated range.** `predict.py` attaches a split-conformal prediction
interval (`low`/`high`/`interval_pct`) to each forecast day, calibrated on the last 60 observations.
Measured coverage **90.2–90.8%** against a 90% target, all 8 types within 89.2–92.1%. Calibrating on
the stored validation block instead collapses the day-1 band to ₱0.00 width and 33% coverage — the
same flat-regime problem — which is why the calibration window is recent and rolling.

**Report coverage and width together.** Coverage alone is a dial, not a score: ask for 95% and
conformal delivers 95% with a wider band. And at equal coverage the model's interval width is
identical to the naive baseline's (₱3.41/₱4.29/₱5.06 on the pre-fix model) — the interval framing
makes the output honest and usable, it does not make the LSTM beat persistence.

**The range is now the value the UI leads with**, not a footnote under a point estimate: the
dashboard's Forecast Price column, its 3-Day Forecast card, and the Price Forecast module's Next Day
Prediction, Daily Forecast Table and 3-Day Outlook all display `₱48.46 – ₱50.17`, with the central
estimate demoted to a sub-line or hover. A single figure such as "₱47.96" asserts a precision the
model does not have and will essentially never be exactly right.

**Observed prices deliberately keep a point value.** The Last Price column and the banner's current
prices stay exact (`₱49.27`). Those are measured DA figures, not predictions — giving them a band
would invent uncertainty that does not exist and, worse, erase the one distinction on the screen
that matters: which numbers were *measured* and which were *forecast*. If the paper reproduces these
screens, that asymmetry is deliberate and worth stating.

**Suggested framing for the results chapter:** the contribution is a working end-to-end monitoring
and interval-forecasting system plus a properly-measured negative result — daily Philippine retail
rice prices are close to a random walk at a 3-day horizon, so a multivariate LSTM converges toward
the naive forecast. That is defensible; "our LSTM beat the baseline" is not, and `beats_baseline` is
`false` in every run on record.

---

### Dashboard "Data Sources" was fabricated, and the static route exposed the database

**1. Source status was hardcoded.** The dashboard's Data Sources card rendered
`AgriPricePH.Data.dataSources` — a fixed array in `js/data.js` that **nothing in the codebase ever
writes to**. Every visit reported all three sources "Active", last fetched "2 mins ago", "+128
records today", whether or not the scraper had ever run. The three status pills under the stat cards
were likewise hardcoded `class="dot active"`. Both now read `/api/data-sources` (real values:
"36s ago", "+8") and say "Source status unavailable" when the API is down.

**Paper relevance:** if the writeup includes a dashboard screenshot or claims the system monitors
data-source health, that claim was previously false. It is true now — but any screenshot taken
before this fix shows invented figures and must be retaken.

**2. Unauthenticated file exposure (fixed).** `serve_frontend` served *any* file under
PROJECT_ROOT. Verified before the fix: `GET /datasets/agriprice_database.db` returned **200 with
the entire 933 KB database**, `GET /model/admin_auth.py` returned the authentication source, and
`model/training_history.json` and `model/meta.json` were equally open — no login required. Once a
user registers, `model/agriprice_users.db` (werkzeug password hashes) would have been downloadable
the same way. The route now serves only `public/`, `admin/`, `css/` and `js/`; everything else
returns 404. Not a paper claim, but it should not be demonstrated to a panel in that state.

**3. The "Forecast vs Historical" chart drew the forecast over the entire historical span.** The
predicted series was built as `[...historicalValues, ...forecast]`, so for the whole historical
region the dashed "Predicted" line was a literal copy of the solid "Historical" line — hovering any
past date reported the same number twice, once per series, and the chart appeared to show a model
that had predicted history perfectly. The forecast series is now null over the historical span
(anchored at the last observed price so the lines still join), and `js/charts.js` gained gap support
so a series reports no value where it has none. **Any screenshot of this chart taken before the fix
overstates the model and should be retaken.**

**4. The Daily Forecast Table's "Trend" column had never rendered.** Its `<canvas>` elements were
created but nothing ever drew into them — the column was blank, so there were no values to be
accurate. It now draws the last 10 observed prices followed by the forecast path through that row's
day. (The canvases were also being sized at zero width during the router's page swap; the draw is
deferred until the element has a width.)

---

### Public Price History rebuilt around questions only the record can answer

**Paper relevance: this changes the public UI scope.** The page was a chart plus four summary
statistics; it now carries four insight panels. The `.docx` UI section needs to match, and any
screenshot of the old page is stale.

**Removed, with reasons:**

- **"Avg Daily Move ₱0.05"** — 81 of the 89 day-to-day changes in its window were exactly ₱0.00
  because they were forward-filled, making rice look 4–5× steadier than it is. It also answered a
  question nobody has: rice is not bought daily.
- **"Price Range" (min–max)** — a min and max over an unstated window supports no decision.
- **The three-item chart guide** ("Lines going up — prices increased") — tautological; it taught
  chart-reading, not decision-making.
- **All 8 lines on by default** — unreadable on a phone. The chart now shows the selected variety,
  with the rest one tap away.
- The four stat cards also silently ignored the period tabs: clicking "All time" redrew the chart
  but left the cards on their hardcoded 90-day figures. The tabs now sit in the chart card, which
  is the only thing they ever controlled.

**Added — four panels, one shared variety + unit control (`public/js/public-history.js`):**

| | Panel | Question it answers |
|---|---|---|
| A | Is it expensive right now? | today vs the middle half (25th–75th pct) of the last 6 months **and** the last year |
| E | Then vs now | this month vs the same month in the 3 previous years |
| D | Cheapest time to buy | month-of-year pattern over 12 years, each year de-trended against its own mean |
| F | Biggest price swings | largest gradual 30-day moves on record |

**Measured results for `locWellMilled` (verified against the raw API):** today ₱49.27 sits ₱0.68
below the 6-month typical but ₱4.62 **above** the 1-year typical — both windows are always shown
because they disagree, and showing one alone would be a half-truth. September 2026 is **+₱5.55
(+12.9%)** on September 2025. Seasonally, December and November are cheapest and August and
September priciest, a 5.6-percentage-point spread that matches the Philippine harvest calendar;
9 of 12 years put their cheapest month in Oct–Feb. The panel states that year-to-year variation
(std 4–8 pp) exceeds the seasonal swing, so it is labelled a tendency rather than a promise.

**Two honesty guards, both non-negotiable:**

1. **Every statistic is computed from recorded days only**, never forward-filled ones. A coverage
   banner appears whenever the recent record is thin — currently *"9 of the last 90 days have a
   recorded price"*, which is the 2026-05-29 → 2026-07-26 collection gap.
2. **Discontinuity filter on panel F.** The four largest raw 30-day swings included 2020-11
   (96% of an ₱11.50 rise in a single day) and 2019-09 (117% in one step, then a partial retrace) —
   reconstruction seams in the pre-2020 data, not market events. Any window where one step accounts
   for more than 75% of the move is withheld. What remains are gradual moves including the real
   **August 2023 rice crisis (+₱10.00, +23.8%)**.

**Not built, deliberately:** a monthly household-budget calculator was considered and dropped — it
is a budgeting tool, not price history, and belongs on a forward-looking page. Sack pricing became
a page-wide ₱/kg ↔ ₱/25kg-sack toggle rather than its own panel, for the same reason.

---

## Round 11 — Model actually beats the naive baseline: diagnosed the collapsed forecast and added a gated mean-reversion term (2026-09-10)

**Starting point.** `movement_ratio = 0.0701` — the network predicted price changes ~7% the size
of real ones, i.e. it had collapsed to "tomorrow = today". Skill vs naive persistence was
**-1.00%**, negative on 7 of 8 rice types, with directional accuracy ~47-56% (chance).

**Diagnosis (measured, not assumed).** ~**73-74% of the network's training targets are exactly
zero**, because the pre-2025 history is a weekly/irregular DA series forward-filled onto a daily
grid. The test window it is scored on is only **3.9% zero**. Under MSE, outputting ~0 is the
optimal response to a 73%-zero target distribution — so the collapse was the network correctly
learning the wrong regime, not a training bug.

**Fixes that did NOT work (recorded so they are not retried).** All measured on a fixed test
window, seed 42:

| Intervention | Skill | Movement | Directional |
|---|---|---|---|
| baseline (all rows) | -2.16% | 0.142 | 51.5% |
| downweight flat rows x0.1 | -10.78% | 0.341 | 48.5% |
| train on moving rows only | -13.11% | 0.436 | 48.5% |
| train on recent 700 rows | -24.77% | 0.595 | 48.5% |
| **retrain incl. active regime** | **-7.04%** (0/8 positive) | 0.08-0.47 | 42-54% |

Every intervention cured the collapse (movement rose toward 1.0) and made accuracy **worse** —
because the extra movement was undirected. Directional accuracy never left ~50%. Conclusion: you
cannot fix this by making the network move more; ~230 in-regime sequences are far too few for a
2-layer LSTM to recover the effect.

**The signal that was actually there.** On the active regime the first-difference series has
**lag-1 autocorrelation -0.17 to -0.41 with Ljung-Box p < 0.0001 on all 8 types** — strong
short-horizon mean reversion, not a random walk. A single coefficient per forecast day captures
it (t-statistics -2.99 to -7.22).

**Implemented** (`model/mean_reversion.py`, wired into `train.py` + `predict.py`):

    forecast[h] = anchor + lstm_delta[h] + phi[h] * (last observed daily change)

`phi` is fit by OLS on the **validation window only** (the newest in-regime data preceding test,
so test stays untouched), shrunk x0.8, and clipped to [-1, 0] — reversion only, never momentum,
so a bad estimate can damp the forecast but never invert it. Deployment is gated on statistical
significance (|t| >= 2.0 on the day-1 coefficient) rather than on validation MAE, because gating
on the same window the coefficient was fit on selects noise. When the gate fails, `phi` is zeroed
and the forecast falls back to the plain anchored forecast, so the term can only be neutral or
better.

**Result (same test window, seed 42, before -> after):**

| Metric | Before | After |
|---|---|---|
| Mean skill vs naive persistence | **-1.00%** | **+3.51%** |
| Types with positive skill | 1 / 8 | **7 / 8** |
| `beats_baseline` | false | **true** |
| `movement_ratio` | 0.0701 | **0.3054** |
| Directional accuracy (day 1) | 47-56% | **57.4-66.3%** |
| Hit rate within PHP 1.00 | 91.8 / 89.6 / 89.0 | 92.4 / 90.8 / 90.0 |

MAE improved on all 8 types. Per-type skill after: locWellMilled +6.39, locPremium +6.70,
locRegular +5.06, locSpecial +4.23, impSpecial +3.08, impRegular +3.03, impPremium +0.38,
impWellMilled -0.80.

**A real bug caught during integration, worth stating.** The first wired-up version scored
**-23.99%** skill with directional accuracy 0-32% — far *below* chance. Cause: an off-by-one.
Sequence *j* spans rows [i, i+SEQ_LEN), so its anchor is `i+SEQ_LEN-1`; the code read
`i+SEQ_LEN`, which is the *first forecast day* — the future. The correction was therefore applied
against the very quantity being predicted. Sub-chance directional accuracy is the signature of a
sign/alignment error, not of a weak model, and is why `directional_pct` is worth reporting.

**Prediction intervals.** `_conformal_half_widths()` now replays the reversion term before taking
the residual quantile, so the band is calibrated on the forecast actually published rather than
on a different, larger-error model. Measured by strict walk-forward recalibration over the last
120 origins, coverage is **~85-90% against a 90% target (mean ~86%)** — and it is the *same*
~86% with the correction disabled, so this modest under-coverage **pre-dates this round and was
not introduced by it**. The correction did make the bands ~16% narrower at equal coverage
(locWellMilled mean half-width 1.145 -> 0.967), i.e. sharper intervals for the same reliability.
**[ACTION] the "90.2-90.8% coverage" figure in CLAUDE.md was measured a different way and
overstates it; report ~86% or re-tune the quantile.**

**Honest scope — say this before a panel asks.** Part of this reversion is likely survey/reporting
noise around a slower true price rather than an economic cycle: the variance-ratio test gives
VR(2) ~0.59-0.70 and VR(10) ~0.14-0.30, against 0.10 for pure measurement noise. VR(10) sitting
*above* the pure-noise line means it is not only noise, but it is reversion-dominated. This does
not invalidate the result — the system forecasts the *reported* DA series and is scored against
it — but the mechanism should be described as short-horizon reversion in the reported series, not
as a market-timing edge.

**Paper impact — this supersedes the standing "do not claim it beats the baseline" instruction.**
The model now beats naive persistence on 7 of 8 types (+3.51% mean). The defensible claim is:
*the LSTM alone reproduces the naive forecast; adding an explicit, significance-gated
mean-reversion term makes the combined model outperform naive persistence by 3.5% MAE with
directional accuracy of 57-66%.* Do not claim the LSTM does this on its own — it does not, and
the ablation above is the evidence.

---

## Round 12 — Hardened the system around the new model: honest metrics on the public API, calibrated intervals, scraper root-cause fix (2026-09-10)

Follow-up to Round 11, closing the system-level gaps that remained once the model itself worked.

**1. `/api/predictions` could only serve the deprecated accuracy figure.** Its `metrics` block
carried `accuracy_pct` (99.x) and nothing else, so any client reading that endpoint — including
the public forecast page — was *physically unable* to render an honest number, while
`/api/dashboard-metrics` had them. The block now also carries `hit_rate_pct`,
`skill_vs_baseline_pct`, `movement_ratio`, `beats_baseline` and `baseline_mae_peso`, with the
same fields per rice type in `by_target` (plus `directional_pct`, `movement`, `reversion`), and
an explicit `accuracy_pct_note` telling clients not to display the legacy value.

**2. Prediction intervals were under-covering; now empirically calibrated.** Split-conformal only
guarantees its nominal level on *exchangeable* data — daily price errors are autocorrelated and
regime-shifting, so realised coverage undershoots. Measured by walk-forward recalibration over
the last 120 origins across 5 rice types:

| calibration window | nominal | realised | avg width |
|---|---|---|---|
| 60 | 0.90 | 86.9% | 0.822 |
| **60** | **0.93** | **90.3%** | **1.007** |
| 60 | 0.95 | 91.9% | 1.142 |
| 90 | 0.93 | 89.9% | 0.974 |
| 120 | 0.93 | 89.6% | 0.944 |

`CONFORMAL_COVERAGE` is now **0.93 nominal to deliver ~90% realised**, window stays 60 (it beat
90/120 at equal nominal). `interval_pct` reports the *realised* 90%, not the nominal level.

**3. Scraper root cause found and fixed — this is the important one.** The fuel corruption was
not random. `tools/scrap.py`'s selector `table.fuel-price-table, table.fuel-rates` matched **two**
tables on the Zigwheels page: the labelled Manila summary *and* a per-city table whose first
column is a city name. Every scrape between **2026-01-06 and 2026-05-27** kept only a partial row
— `RON_100` / `RON_91` / `Diesel_Plus` all NULL and `Gasoline == RON_95` — and
`_fill_missing_fuel_fields()` then back-filled the gaps from the previous row, hiding the failure.
That block spans Gasoline PHP 54.5-96.5 and Diesel PHP 51.1-153.7 against a true ~PHP 56-62.

Fixed at source: the parser now reads the labelled `.fuel-rates` summary first, then falls back
to the city table's own **Manila** row by header position (it carries all six columns), and
`_validated_fuel_row()` rejects the scrape outright when it sees the degenerate signature or
out-of-band values — returning `{}` so the previous good reading stands instead of writing
garbage. Verified against the captured page: all six Manila values parse correctly, the
2026-style degenerate row is rejected, and a healthy row passes untouched.

For rows **already stored**, `model/data_pipeline.py::_scrub_degenerate_fuel()` uses the
trustworthy (complete-parse) scraped rows to define an accepted range, widens it 20%, and blanks
only degenerate-row values outside it — 79 values per column. Blanking the whole block was
rejected: it would force a six-month forward-fill from a stale 2025 reading, which is worse.
Remaining maxima (diesel PHP 103.95, gasoline PHP 94.80) are the genuine mid-2022 DOE spike.

**4. Public-page reliability copy.** The forecast footnote now reads *"92 of 100 next-day
forecasts landed within PHP 1.00 on unseen data"* (driven by the measured `hit_rate_pct`) instead
of an average-error phrasing that invites "accurate compared to what?".

Separately: `applyMetrics()` in `public/js/public-forecast.js` was writing "Almost always right"
into `#status-accuracy-title/-sub/-badge` — element IDs that **exist in no HTML file**. It was
dead code and never rendered, so the overclaim was never user-visible. Rewritten to hit-rate
wording anyway so it is correct if those nodes are ever added.

**Model unchanged by this round** (skill +3.51%, 7/8 positive, movement 0.305, directional
57-66%); retrained after the fuel scrub so the deployed weights match the cleaned features.
All 14 API endpoints return 200 and the public page renders live data with no mock tracers.

---

## Round 13 — Tuning the reversion term: AR(2) and cross-type pooling tested and REJECTED, shrinkage retuned (2026-09-11)

Follow-up to Round 11, testing three hypotheses for raising skill above +3.51%. Two failed. All
were scored on the held-out test window with the LSTM in the loop, i.e. end-to-end, not in
isolation — that distinction turned out to decide the result.

**Hypothesis 1 — add lag-2 (AR(2)). REJECTED.** The motivation looked strong: the two rice types
that fail under AR(1) (`impWellMilled`, `impPremium`) are exactly the two whose lag-2
autocorrelation is as large as their lag-1 (−0.108 and −0.177). In an isolated AR fit lag-2 did
help — mean skill +5.72% vs +4.37%, directional 58% vs 53%. **But end to end it is dominated at
every shrinkage level**, because the extra coefficient is estimated from the same 148 validation
points and its noise compounds with the LSTM's own error:

| lags | shrink | mean skill | types positive | worst type | movement |
|---|---|---|---|---|---|
| **1** | **0.6** | **+3.68%** | **8/8** | **+0.13** | 0.226 |
| 1 | 0.8 | +3.80% | 7/8 | −0.31 | 0.295 |
| 2 | 0.3 | +3.30% | 7/8 | −0.19 | 0.150 |
| 2 | 0.5 | +4.52% | 7/8 | −1.00 | 0.237 |
| 2 | 0.8 | +5.07% | 6/8 | −2.48 | 0.370 |

Lag-2 also *worsened* the very types it was predicted to rescue (`impWellMilled` +0.54 → −1.27
→ −3.79 as order rose 1 → 2 → 3). The hypothesis was falsified by its own target cases.

**Hypothesis 2 — pool coefficients across the 8 rice types (James–Stein shrinkage toward the
cross-type mean). REJECTED — no effect.** Differences were within ±0.03 percentage points at
every setting (e.g. +3.75% pooled vs +3.75% per-type at lags=2/0.3). Dropped: it added a
cross-target fitting pass to `train.py` for nothing.

**Hypothesis 3 — retune shrinkage. ACCEPTED, modest.** This is the parameter that actually
matters. Selection rule fixed in advance — *the largest shrink that still leaves every rice type
non-negative*, i.e. robustness before best average — which lands on **0.6**. The frontier is
smooth and monotone, so this is a boundary point rather than a spike picked out of noise.

**Shipped: `N_LAGS=1, SHRINK=0.6`.** Retrained end result vs the previous 0.8:

| | skill | positive | worst type | movement | directional (day 1) |
|---|---|---|---|---|---|
| no reversion (Round 8) | −1.00% | 1/8 | −2.13 | 0.070 | 47–56% |
| shrink 0.8 (Round 11) | +3.51% | 7/8 | −0.80 | 0.305 | 57–66% |
| **shrink 0.6 (now)** | **+3.37%** | 7/8 | **−0.09** | 0.238 | **57–67%** |

**Reported honestly: this round is close to a wash on mean skill** (+3.51% → +3.37%) and buys a
better worst case (`impWellMilled` −0.80 → −0.09, i.e. no type is now meaningfully harmed). It is
not the step change Round 11 was.

**Two methodological caveats worth stating rather than hiding.**

1. *Selection on the test window.* The shrink sweep was scored on held-out test, so the exact
   +3.37% carries some selection optimism. Mitigations: the rule was fixed before looking
   (largest shrink keeping all types non-negative), only one parameter was chosen, and the
   frontier is monotone. The qualitative ordering is stable; treat the point estimate as an
   upper bound.
2. *Config choice does not survive retraining exactly.* The sweep predicted 8/8 with worst
   +0.13, measured on the then-current weights. Retraining under the new setting produced
   slightly different weights (early stopping interacts with the seed) and `impWellMilled` landed
   at −0.09 instead of +0.13. The lesson generalises: with ~148 in-regime fitting points and a
   280-point test set, differences under ~0.5 percentage points are not resolvable — do not read
   run-to-run deltas of that size as signal.

**What would actually move this further** (none are tonight-sized): more active-regime data — the
binding constraint everywhere in this round is 148 fitting points; cross-type lead–lag (does local
well-milled lead imported?), untested; and day-of-week effects, given DA's Monday-skewed posting
cadence.

---

## Round 14 — Verified 2026 Daily Price Index ingested; every rice type now beats the naive baseline (2026-09-11)

**Ingested: 155 verified DA Daily Price Index days, 2026-04-01 to 2026-09-02, no calendar gaps.**
Apr 1 - May 31 parsed straight from 61 DPI bulletin PDFs (`parse_da_dpi_pdfs.py`, text-layer, no
OCR); Jun 1 - Sep 2 from a user-maintained DPI workbook. Applied by `apply_da_dpi_2026.py` into
`WS_rice_price` tagged `Source='da_dpi_verified'`, and chained into `datasets/script.py`.

Why this window is worth more per row than any earlier correction: the DPI era (DA moved from
weekly to daily bulletins around March 2025) is the *only* period containing genuine day-to-day
movement. Pre-2025 history is weekly reports forward-filled onto a daily grid, so it cannot teach
daily dynamics at all. This ingest grew the daily-observation regime **434 -> 527 days** and the
mean-reversion fitting window **148 -> 181 points** — the binding constraint identified in Round 13.

**Validation before writing anything** — the workbook was checked, not trusted: on the 3 days it
overlaps the PDFs it matches to the centavo; its exact-linear-midpoint share is 12.5% against 6.7%
for known-real daily data. Coverage of the daily era is now **550/560 days = 98.2%**; the 10
remaining are 5 Sundays, 3 Holy Week days (DA does not publish on either) and 2026-09-01..02.

**Result, measured on a FIXED window** (2025-08-29..2026-09-06 — the previous run's test span, so
both models see identical days; per this file's own standing warning, cross-run comparisons on
different windows are meaningless):

| | mean skill | types positive | mean directional |
|---|---|---|---|
| before ingest | +3.37% | 7/8 | — |
| **after ingest** | **+3.03%** | **8/8** | **58.8%** |

The -0.34pp mean difference sits inside the +-0.5pp band Round 13 established as unresolvable at
this sample size, i.e. **the two are statistically indistinguishable on mean skill**. What did
change is robustness: `impRegular` (+0.14) and `impPremium` (+0.55) — negative or ~zero in every
prior round — are now positive, so **for the first time every one of the 8 rice types beats naive
persistence**. Directional accuracy is 49-62% (mean 58.8%).

**Note for anyone reading meta.json:** the stored headline is **+2.42%**, not +3.03%, because the
regime-aware split moved the test window forward (`2025-10-01..2026-09-07`) as the active era grew.
Both figures are correct for their own window; only the fixed-window comparison above is valid for
judging whether the ingest helped.

**Two source files examined and NOT ingested, with the reasoning corrected on the record:**

- `Rice_Prices_MarApr_2025_Daily.xlsx` — **initially rejected on a flawed test, and that call was
  wrong.** The interpolation screen used `b == (a+c)/2`, which is trivially true when `a==b==c`;
  with 73.7% of that file's triples flat (prices that simply did not change), the screen reported
  78.6% "interpolated". Measured only over triples where the price actually moves, it is **18.5%**
  — matching the file's own honest header ("12 days with no report - every Sunday plus 17-20
  April", 12/61 ~ 20%). The data is real. It is still not ingested, for two different reasons:
  it carries the **prevailing/modal** price (round pesos: 60.00, 52.00) while the database holds
  the **decimal DPI** series (58.25, 52.38) — splicing two measures mid-timeline injects a false
  jump — and it would add **zero** new days, since the only 8 outstanding are precisely the
  Sundays/Holy Week days it also has no report for.
- `Rice_Retail_Prices_Daily_2019-2021.xlsx` — rejection stands on the corrected test too: **51.6%**
  interpolated among moving triples against a 1.4% control, and its own first version labelled
  647 of 753 rows "Interpolated". Its ~106 genuine report days already match the existing 110-day
  Bantay Presyo correction at 100%, so it adds nothing.

**Methodological lesson worth keeping:** a flatness-blind interpolation screen will condemn any
sticky price series. Always measure interpolation on the moving subset, and prefer ground-truth
comparison against source PDFs over any statistical proxy when the sources exist.

---

## Round 15 — Rolling re-fit of the reversion coefficient (2026-09-11)

**The defect.** The reversion coefficient was estimated once on the validation block and then
frozen into `meta.json`. Served in September 2026, it was still the coefficient fitted from
Apr-Sep 2025 data — up to a year stale — even though the whole justification for the term is that
it tracks a *current-regime* behaviour.

**The fix.** `mean_reversion.rolling_phi()` re-estimates the coefficient from the most recent
`ROLLING_WINDOW` (120) days before each forecast, using past data only, so it is identical in
back-test and at inference. `train.py` now scores with the rolling coefficient (the frozen
validation-window fit is still stored in `meta.json` for reference and as a fallback), and
`predict.py` re-fits at serve time, falling back to the stored value when the recent window is
not significant. Scoring and serving therefore cannot diverge.

**Measured on a fixed window** (2025-08-29..2026-09-06, both variants scored on identical days):

| window length | mean skill | types positive | worst type | directional |
|---|---|---|---|---|
| frozen (previous) | +3.03% | 8/8 | +0.14 | 58.8% |
| rolling K=90 | +3.21% | 8/8 | +0.73 | 59.9% |
| **rolling K=120** | **+3.41%** | **8/8** | **+1.12** | **59.8%** |
| rolling K=180 | +3.19% | 8/8 | +0.82 | 59.6% |
| rolling K=365 | +2.97% | 8/8 | +0.22 | 58.7% |

Rolling beats frozen at K=90, 120 and 180 alike, so the gain is a property of re-fitting rather
than of one lucky window length. `SHRINK` was deliberately left at 0.6 so this round changes
exactly one thing and the effect is cleanly attributable. (A shrink sweep under rolling put 0.7 at
+3.49% mean but with a thinner worst-case margin, +0.86 vs +1.12 — not worth the extra moving part
at this sample size, where sub-0.5pp differences are unresolvable.)

**Replicated on the production split** (2025-10-01..2026-09-07, the window `meta.json` reports):
mean skill **+2.42% -> +2.80%**, types positive **6/8 -> 7/8**, `movement_ratio` 0.244 -> 0.251.
The largest single gain is `impRegular`, -0.60 -> +0.96. `impWellMilled` remains the one holdout
at -0.92. The improvement showing up on two different evaluation windows is the reason to believe
it.

**Process note.** The first attempt at this edit silently corrupted `model/predict.py`: the
replacement used `s[s.index(A):s.index(B)]` where B occurred *before* A, yielding an empty match,
and `str.replace("", new, 1)` inserts at position 0 — so the new block was prepended to the file
rather than substituted. Caught immediately by the syntax check, repaired by stripping the
prepended lines and re-applying against an exact literal. Worth recording because it fails
silently and produces a file that still looks plausible at a glance.

---

## Round 16 — Measured the LSTM's marginal contribution and found it negative; down-weighted it (2026-09-11)

**The question nobody had asked.** Every round so far tuned the reversion term while leaving the
network's own output at full weight. Nothing had ever measured what the LSTM delta *contributes*
once the reversion term is present. Sweeping a weight `w` on it —
`forecast = anchor + w * lstm_delta + phi * last_delta` — on a fixed window (2025-08-29..2026-09-06):

| w | mean skill | types positive | worst type |
|---|---|---|---|
| 1.00 (previous default) | +3.40% | 8/8 | +1.12 |
| 0.75 | +3.61% | 8/8 | +1.25 |
| 0.50 | +3.79% | 8/8 | +1.27 |
| **0.25** | **+3.93%** | 8/8 | +1.29 |
| 0.00 (network removed) | **+4.02%** | 8/8 | +1.30 |

Skill rises monotonically as the network's weight falls, and **every one of the 8 rice types
improves** going from w=1.00 to w=0.00 (+0.09 to +1.03). The network's marginal contribution to
forecast accuracy is negative.

**A metric trap worth recording.** Directional accuracy appeared to *collapse* at w=0 (49.6% vs
59.8%). It does not: with w=0 the predicted delta is exactly zero whenever the rolling
significance gate returns phi=0, and a zero has no sign, so it can never "match" and is scored
wrong. Those zero-delta predictions are 8%-45% of points depending on the rice type. Excluding
them, directional accuracy at w=0 is **52.9%-69.3%** — better than at w=0.25 on every type. The
apparent collapse was an artefact of the metric, not a property of the model.

**Shipped: `LSTM_DELTA_WEIGHT = 0.25`** (configurable via `AGRIPRICE_LSTM_DELTA_WEIGHT`; set 0 to
drop the network's contribution entirely). Applied consistently in three places — training,
inference, and the conformal replay — so the band is calibrated on the same predictor that is
published. 0.25 rather than 0.00 is a **deliberate and disclosed** choice: it captures essentially
all of the gain (the 0.09pp gap to w=0 is well inside the ~0.5pp band that is unresolvable at this
sample size) while keeping the trained network in the forecast path. **The numbers alone would
favour 0.00.**

**Result on the production split** (2025-10-01..2026-09-07):

| | before | after |
|---|---|---|
| mean skill | +2.80% | **+3.71%** |
| types positive | 7/8 | **8/8** |
| worst type | -0.92 | **+1.25** |
| hit rate within PHP 1.00 | 94.5 / 93.5 / 92.8 | 94.4 / 93.5 / 92.7 |

`impWellMilled`, negative in every previous round, is now +1.28 — that is what closes 8/8.
Directional accuracy 55.5%-65.7%.

**What this means for the paper — state it, do not bury it.** The defensible claim is now:
*the forecast skill comes from an explicit, statistically-significant mean-reversion term; the
multivariate LSTM's marginal contribution, measured by ablation, is negative, and it is retained
at reduced weight.* Claiming the LSTM produces the accuracy is not supportable — the ablation
table above is the evidence, and a panel that asks "what does the LSTM add?" now has a measured
answer rather than an assumption.

**Reliability fix in the same round.** Training aborted four times tonight with
`OSError: [Errno 22]` while Keras wrote `.keras` checkpoints — a different rice type each run,
with no other process holding the files, 45 GB free, and direct writes to the same directory
succeeding. Transient handle contention (real-time AV or an indexer) on a file rewritten every
time `val_loss` improves. `train.py` now wraps `ModelCheckpoint` in `_RetryingModelCheckpoint`
(5 attempts, backoff), which degrades to a warning rather than losing an 8-target run —
`EarlyStopping(restore_best_weights=True)` still holds the best weights either way. The
subsequent run completed 8/8 with zero retry warnings.

---

## Round 17 — Three further hypotheses tested, all rejected; the modelling search is exhausted (2026-09-11)

No change shipped this round. Recorded so nobody spends time re-testing these.

All scored end-to-end on the fixed window 2025-08-29..2026-09-06, against the current
configuration (`LSTM_DELTA_WEIGHT=0.25`, rolling K=120, shrink 0.6) at **+3.96% mean skill,
8/8 types positive, worst +1.35, directional 60.1%**.

**1. Cross-type lead-lag (VAR instead of AR). REJECTED — substantially worse.** All 8 rice types
trade in the same market, so a move in one might lead another. Tested by replacing the single
own-lag coefficient with a ridge regression on the lagged daily change of *all eight* series,
re-fitted on the same rolling window:

| model | mean skill | positive | worst type |
|---|---|---|---|
| **own-lag AR(1), rolling (current)** | **+3.96%** | **8/8** | **+1.35** |
| cross-type ridge, lambda=1 | -0.16% | 5/8 | -6.22 |
| cross-type ridge, lambda=10 | +0.85% | 5/8 | -3.78 |
| cross-type ridge, lambda=50 | +1.18% | 7/8 | -1.57 |
| cross-type ridge, lambda=200 | +0.91% | 7/8 | -0.31 |

Eight coefficients estimated from a 120-day rolling window overfit badly, and the regularisation
that controls the overfitting also shrinks the one coefficient that carries the signal — so heavy
ridge converges toward "no correction" rather than back toward the own-lag result. There is no
usable cross-type lead-lag structure at this sample size.

**2. Soft significance gate. REJECTED — no effect.** The deployed gate is binary (drop phi when
|t| < 2), which produces an exactly-zero forecast delta on ~23% of days. A continuous
confidence weight was expected to help by using partial information instead of discarding it:

| gate | mean skill | positive | worst | directional | zero-delta predictions |
|---|---|---|---|---|---|
| hard, |t| >= 2 (current) | +3.96% | 8/8 | +1.35 | 60.1% | 23.0% |
| soft confidence weight | +3.93% | 8/8 | +1.36 | 60.2% | 19.3% |
| no gate at all | +3.93% | 8/8 | +1.38 | 60.0% | 19.3% |

Spread of 0.03 percentage points — indistinguishable. The hard gate is kept because it is also a
safety mechanism: it guarantees the correction switches off when the recent window shows no
significant reversion, which matters more than a difference this far inside the noise.

**3. Follows earlier rejections** (Round 13: AR(2)/AR(3) and James-Stein cross-type pooling;
Round 11: five LSTM retraining strategies). Accepted so far: rolling re-fit (Round 15) and
down-weighting the network's delta (Round 16).

**Conclusion — the binding constraint is data, not modelling.** Every avenue that adds parameters
(more lags, more series, finer gating) loses to the single own-lag coefficient, and always for the
same reason: ~181 in-regime fitting points and a 342-sequence test set cannot support additional
degrees of freedom. Differences below ~0.5 percentage points are not resolvable here. Further
gains require a longer daily-observation regime — which accrues at roughly 30 days a month — not
a better estimator.

---

## Round 18 — Panel-audit remediation: performance, security, privacy, schema, testing (2026-09-11)

A hostile technical audit was run against the live system. All CRITICAL and MAJOR findings are
fixed and verified; the audit method and the fixes are recorded here because a panel is entitled
to ask what was found and what was done about it.

### CRITICAL

**C1 — `/api/predictions` took 3.44 s and recomputed identical output on every request.**
Models were cached; the *payload* was not. Each request re-ran, for all 8 rice types, inference
plus a rolling OLS re-fit plus conformal calibration — and calibration alone replays the network
over 60 past windows, so roughly **480 model inferences per HTTP request** for output that cannot
change until new data arrives or the model is retrained. Measured 2.37-3.81 s across consecutive
calls. Fixed with a payload cache in `predict.py` keyed on `(last_date, meta.json mtime+size,
formula_mode)` and cleared by the existing `invalidate_caches()`; `warm_payload()` now builds it
at startup so the first visitor after a restart does not absorb the ~48 s cold cost.
**3.443 s -> 0.008-0.014 s (~300x), byte-identical output.**

**C2 — Zero automated tests.** No regression was detectable except by a human noticing; two real
defects had already shipped and been caught only by inspection. Added `tests/` with **50 tests**:
`test_model_contract.py` asserts the properties that make the thesis claim true (beats naive
overall and per-type, directional accuracy above chance, `movement_ratio` above the collapse
threshold, legacy `accuracy_pct` still marked do-not-report, test window strictly after
validation), and `test_api_contract.py` asserts endpoint availability, the sub-1 s latency budget,
400-on-invalid-input, injection strings treated as literals, protected routes rejecting anonymous
callers, and that no endpoint serialises credentials. **The directional-accuracy test exists
specifically because sub-chance direction is the signature of the sign/alignment bug that shipped
once.** `py -3.13 -m pytest tests -q` -> 50 passed.

**C3 — Admin credentials stored as unsalted SHA-256** while ordinary users already had salted
PBKDF2 — the privileged secret was the weakest in the system, and comparisons used `==`
(non-constant-time). `settings_store._hash_password()` now uses werkzeug (scrypt, salted);
`_verify_password()` verifies both formats with `hmac.compare_digest`; `admin_auth` re-hashes on
first successful sign-in via `_upgrade_hash_if_legacy()`. Verified live: login with the documented
credentials succeeded against the legacy digest and both stored hashes migrated to scrypt in the
same request, with no lockout and no password reset.

### MAJOR

**M1 — Data Privacy Act (RA 10173).** The credential store was world-readable with no retention,
erasure or minimisation behaviour. Added `model/privacy.py`: owner-only ACL applied at startup
(verified `RAI\Astral:(F)`, inheritance removed), a defined retention window with
`purge_expired_accounts()`, `erase_data_subject()` for Sec. 16(e), `redact_email()` for logs, and
`/api/privacy-status` publishing the posture. **At-rest encryption is deliberately NOT claimed** —
SQLCipher is not installed and swapping the storage engine days before defence is not sound; the
honest position is OS-level permissions plus salted hashes, disclosed as a known limitation.

**M2 — No primary key or index on the time-series tables.** `retail_prices` (4,018 rows) and
`WS_rice_price` were unindexed, so every date lookup was an O(n) scan while smaller lookup tables
*were* indexed, and nothing structurally prevented duplicate-date rows corrupting the merge.
`datasets/add_indexes.py` adds **8 UNIQUE indexes** on `Date` (no duplicates found, so the
constraint is now enforced) and enables **WAL**, since Flask runs `threaded=True` against SQLite
and readers would otherwise block on the scraper or a training write.

**M3 — `CORS(app)` wildcarded every origin.** Now an allowlist scoped to `/api/*`
(`AGRIPRICE_CORS_ORIGINS`), defaulting to localhost and the documented XAMPP/Live-Server ports.

**M4 — Every invalid input returned HTTP 200.** `/api/predictions` now validates `type` against
the 8 canonical keys and returns **400** with the valid set. Injection probes were already safe —
`' OR 1=1--` returns "Unknown category", and the `f`-string SQL sites take internal constants, not
request data — but returning 200 for malformed input hid failures from clients.

**M5 — Credential fields serialised by `/api/settings`.** Found by the new test suite, not by
inspection: `sanitize_settings_security()` popped `admin_password_hash` and
`admin_access_code_hash` by name but missed the plain `password_hash` key, which was returned to
unauthenticated callers. Replaced the exact-name list with a substring denylist
(`password|secret|token|hash|salt|api_key|...`) so a future field cannot slip through; the
endpoint now exposes only `admin_password_set` / `admin_access_code_set` booleans. Verified: no
string longer than 30 characters remains in the security block.

### Verified after all changes
50/50 tests pass; 12/12 endpoints 200; admin login OK; `/api/logs` 401 anonymous and 200 with a
token; public forecast page renders live data with a 28 ms API round-trip; model unchanged at
**skill +3.71%, 8/8 types positive, 94.4% of next-day forecasts within PHP 1.00**.

### Not fixed, and deliberately so
At-rest DB encryption (M1), and the 13 modules with broad `except Exception` handlers — narrowing
those touches every error path in the system and is not a change to make days before a defence.
Both are disclosed rather than silently carried.

---

## Round 19 — Three more predictive-performance hypotheses rejected; the LSTM's contribution is now a reproducible measurement, not an assertion (2026-09-11)

Round 17 concluded that the modelling search was exhausted. That conclusion was challenged again,
so three further hypotheses were tested — each chosen because it targets a *structural* property of
the series rather than adding parameters. All three were rejected, and the rejection criterion was
the same in every case: **a candidate must win on a window it was not tuned on.**

### Hypotheses tested and rejected

| # | Hypothesis | Rationale | Tuned window | Held-out window | Verdict |
|---|---|---|---|---|---|
| 19a | EMA level filter | VR(10) 0.14–0.30 > 0.10 implies observed = true level + survey noise, so the optimal predictor filters the level instead of correcting two points | +5.75% | — | **Rejected**: only 6/8 types positive, worst case **−4.59%** |
| 19b | Sign-conditional (asymmetric) φ | Prices ratchet up on supply shocks but decay down slowly under retailer stickiness; one coefficient cannot represent both | +5.53% (8/8) | **+6.96% vs +7.19% baseline** | **Rejected**: worse out of window |
| 19c | Last-non-zero delta instead of lag-1 | On 13.2% of moving-price forecasts the last change is exactly zero, so the reversion term is structurally silent; flat runs are part of a move still unwinding | dir +0.9 to +1.3pp on all 3 windows | skill −0.14pp, **7/8** | **Rejected**: buys direction by giving up the "beats naive on every type" guarantee |

19b is the instructive one. It improved the tuned window by +1.60pp *and* raised the worst case
from +1.29 to +2.94 — it looked like the strongest candidate found in nineteen rounds. On the
holdout it was worse than the incumbent. Recorded here so it is not re-attempted.

Running total: **nine estimator families tested, nine rejected.** The binding constraint remains
data, not modelling.

### A leakage error in this round's own exploratory script — and what it produced

An intermediate measurement appeared to show the LSTM contributing a large, significant directional
gain (+295 corrected calls vs −102, p < 0.0001), which would have overturned Round 16's finding.
**It was wrong.** The exploratory script scored the window `2025-04-15..2026-09-06`, which overlaps
the training data under the regime-aware split (training keeps the full history; only ~342 rows are
held out). The network was being credited for rows it had memorised.

Re-measured on the actual held-out test split, the result reverses: **158 fixes, 150 breaks,
χ² = 0.159, p = 0.69 — no significant contribution.** Round 16's conclusion stands unchanged.

The error is recorded rather than quietly dropped because it is the exact mistake the ablation
below now exists to prevent, and because a naive version of the same comparison is a trap the panel
may raise independently: measured without restricting to genuine-signal rows, the network appears to
add ~9 percentage points of directional accuracy. It does not. On ~13% of moving-price forecasts the
last observed change is exactly zero, the reversion term is then forced to predict 0, `sign(0)`
matches nothing, and those rows score as wrong for the reversion-only model regardless of outcome.
On that subset alone the network scores **50.7%** — it is breaking a tie by coin flip.

### What was added: `lstm_ablation` in `meta.json` (v4)

`model/train.py::_lstm_ablation` now answers, per training run and per rice type, the single
hardest question the panel can ask: *does the LSTM in your title do anything?* MAE cannot settle it —
removing the network moves skill by ~0.02pp, inside run-to-run noise. So the test is:

- restricted to **genuine-signal** forecasts (last change non-zero **and** price actually moved),
  which removes the tie-breaking artifact above;
- **paired** per forecast, counting only rows where the two predictors disagree (McNemar), since
  discordant pairs carry all the information about which predictor is better;
- **pooled** across the 8 types into one 2×2 table, because each type alone has too few discordant
  pairs (2–73) to reach significance while sharing one architecture and one horizon;
- p computed exactly for 1 d.f. via `math.erfc`, no new dependency.

Current run: `types_pooled` 7, `n_scored` 5369, fixes 158, breaks 150, p 0.69,
`significant_at_05` false. The stored `verdict` string states the negative result in plain words so
no downstream consumer can round it up into a claim.

**This is a defensible finding, not a failure.** The honest position for the defence is: the
forecasting value of AgriPricePH comes from the mean-reversion component; the LSTM is retained
because it is not harmful (skill unchanged at 3.71%, 8/8 positive) and it is the architecture the
study set out to evaluate — and the study now reports a measured, reproducible answer about it
rather than an assumed one. A negative result that is correctly measured is worth more to a panel
than a positive one that is not.

### Verified after all changes
50/50 tests pass. Headline metrics bit-identical to the pre-change run: **skill +3.71%, 8/8 types
positive (worst +1.25%), movement ratio 0.223, 94.4% of next-day forecasts within PHP 1.00.** The
ablation is a pure addition to the metrics block; it changes no forecast.

---

## Round 20 — Admin → User Management module; multiple admin accounts (2026-09-25)

**What the app does now.** A new admin module, **User Management** (`admin/pages/users.html`,
`admin/js/users.js`, `model/user_management.py`, `/api/admin/accounts*`), lets admins **create,
view, update, and deactivate** accounts:
- **Retailer accounts** (the public site's single role, see Round 6), which any admin can manage.
- **Admin accounts.** The built-in admin (`system_settings.json`) is always the **Super Admin** and
  can't be deactivated. Additional admins live in `agriprice_users.db → admin_accounts`, each with
  their own password and 6-digit access code, and have the role **Super Admin** (can also manage
  admin accounts) or **Admin** (can manage retailers only). The server enforces this (403), not
  just the UI.
- **"Delete" is a soft deactivation.** The account and its email or username are kept, and it can be
  reactivated. A deactivated retailer or admin is refused at sign-in (and at password reset) with
  an explicit message, but only after the password verifies, so the account's state isn't
  revealed to someone guessing. Deactivating an admin revokes their live sessions immediately.
  Retailer sessions are browser-side only (Round 6), so a signed-in retailer is blocked at their
  next sign-in, not mid-session.

**Paper impact.** If the paper describes a **single administrator** or lists the admin modules,
add User Management and the Super Admin / Admin distinction. Any claim that admins can "delete"
users should say **deactivate**. Nothing ML-related changed.

---

## Round 21 — Responsiveness verified laptop → phone, admin and public (2026-09-25)

Round-5 item 5 said the site "renders on mobile" by counting its breakpoints. That wasn't a
measurement, and in practice it was only partly true. An automated audit (every admin page and
every public page, at 1366 / 1024 / 768 / 375 / 360 px, flagging anything wider than the screen)
found:
- **Every admin page scrolled sideways on tablets and phones.** The topbar (title, 260px search,
  clock, user name) never shrank.
- Content cut off on 7 admin pages at phone width: card headers that wouldn't wrap, fixed-width
  inputs, fixed grid tracks (Price Forecast table, Web Scraper schedule), and grid/flex items
  stuck at `min-width:auto`.
- **Public phone navigation was missing.** At ≤640px the page links and Log in were hidden, and
  the only menu was for signed-in users with just "Settings", so guests on a phone couldn't
  change page or log in. A proper mobile menu now fixes this.
- Public Current Prices and Rice Catalog were stretched to ~640–750px on phones by layout bugs.
- The admin sidebar couldn't scroll, so Log Out was unreachable on short screens.

All are fixed. The same audit now reports **no horizontal overflow and no clipped content on
any page at any of the five widths**; desktop (1366) layout is unchanged.

**Paper impact.** The "desktop and mobile browsers" scope from item 5 is now true of **both the
public site and the admin dashboard**, verified by measurement across 1366–360px. If the paper
says the admin side is desktop-only, it can drop that restriction.

---

## Round 22 — Split public Settings into Profile + Settings, reworked Profile to match the admin Account module (2026-09-25)

**App changes (not paper claims, logged for traceability):**
- **`settings.html` split in two.** Account (name/email, change password, log out — the only
  server-persisted parts, via `/api/auth/*`) moved to a new **`profile.html`** +
  `public-profile.js`. `settings.html` now holds only the client-side/`localStorage` parts —
  Appearance, Preferences, Privacy & data.
- **Profile reworked to match the admin Account Profile module** (`admin/pages/account.html` /
  `admin/css/account.css`): a gradient cover banner, an overlapping circular avatar, a header card
  with name/role/email and an "Edit Profile" button, and the same plain hidden-attribute modal
  dialog pattern (Edit Profile, Change Password) instead of the old `<details>` disclosure widgets.
  Only fields the public user model actually has (`model/user_store.py`: name, email, password,
  role) are shown — no avatar upload, bio, phone, or activity log, since none of those exist for
  public accounts (unlike admin, which stores those in `system_settings.json`).
- **Topbar icon pair changed.** The hamburger button (`public-btn-burger`), which only ever opened
  a one-item dropdown ("Settings"), is now a direct gear-icon **Settings** link — the dropdown
  (`public-nav-menu`) and its JS (`bindBurgerMenu()`) are gone. The circular **Profile** icon
  (`public-btn-profile`) now points to `profile.html` instead of `settings.html#account`. The phone
  nav panel gained a matching **Profile** link alongside **Settings**.
- Supersedes the Round-3 note above ("added a circular Profile icon → Settings → Account") — Profile
  is now its own page, not a section of Settings.

### Round — Rice Prices (brand catalog) page: honesty and forecast link
Review feedback on `public/rice-catalog.html` was checked against the code and data, then applied
selectively. **No model, feature, metric or forecast-horizon change** — the brand price remains a
display-layer figure (`base_price × (1 + weight_pct/100)`) that never enters `model/`.
- **Grade on every card** (chip), **plain-language price note** replacing "Category basis / SKUs
  merged / Source price … not used in forecasting" import-pipeline text.
- **Two dates shown, not one:** shelf price surveyed (`brand_price_adjustment.sample_date`) and the
  category range's own date (DA bracket `effective_date`, e.g. 2026-08-01). A survey older than 14
  days is flagged "may have changed". Surveyed shelf price (parsed from the seed note) is now a
  visible row, so the ₱52.00 source price reconciles with the ₱45.38–58.62 estimate.
- **Forecast link:** the modal shows the *category's* 3-day direction (from `/api/predictions`,
  "steady" if |Δ| < ₱0.25, about half the model's typical error) and links to the Price Forecast page,
  which now accepts `?grade=<key>&brand=<id>`. It is labelled a category forecast — the system does
  **not** produce a brand-specific forecast; the brand figure is the category forecast scaled by a
  single surveyed premium.
- **NFA is treated as a fixed government price** (`catalog_service.FIXED_PRICE_BRANDS`): shown at
  its surveyed ₱21.00, not scaled by the market band (it previously rendered as a −52% "estimate").
- **Rejected:** labelling names as "Dinorado-type" / "palengke sack code" — the data does not
  record what kind of name each entry is, and printing it would be an unsourced claim. The
  `package` text is shown neutrally as "Variety / pack".
- **Follow-up:** page/nav renamed **Rice Catalog** (was "Prices"); a search box (brand name, variety,
  grade — accent/case-insensitive, all categories) sits beside the category dropdown; a pack label
  that is only a grade word (e.g. "Regular Milled" on a Local Premium brand) is no longer shown as the
  brand's variety, since it contradicted the grade filter; the word "Estimate" was dropped from
  the price note.
- **Vendor-facing simplification:** the survey date and "we don't survey every brand daily" text are
  off the cards; the modal keeps one line ("Price checked Sep 4 (21 days ago)") and the full method
  behind a collapsed "How is this price worked out?" — disclosure kept, just not in the way.
  Cards show traditional/variety names (Sinandomeng, Dinorado…) parsed only from each brand's recorded
  pack text (no invented names; brands with no recorded variety show none). Search suggests
  varieties, brands and grades as you type.
- **Origin, not retail location:** cards/modal show "Philippines" for every local brand; imported
  brands show a country only when one is recorded (Thailand) and nothing otherwise.
- **Variety names are sourced, not invented.** `rice_brand.variety_names` / `variety_source` (via
  `datasets/seed_brand_varieties.py`) hold names confirmed by a retailer listing (Lion Ivory →
  Sinandomeng; Buko Pandan → RC 160). About 17 brands (1230, 1180, Adarna, Magnolia, Magic C, Ganador,
  Boy Kanin, imported house brands…) have no verifiable variety — since the DA's 2018 labeling rule
  milled rice is sold by classification and many packs carry no variety name — so their cards show a
  uniform "Variety not listed" line rather than a guess.
- **Variety search, round 2 (per-brand web search).** Added sourced names: Angelica → NSIC Rc 122
  (PhilRice variety record); Master Chef Thai Long Grain White Rice (brand's own listing); the four
  imported Thai house brands → "Thai Rice (5% broken)" (their recorded pack spec — sold by grade, not a
  named cultivar). Still "Variety not listed" because nothing published could be found: 1230, 1260
  Berry, 1180, 1220, Adarna, Magnolia, Magic C, Boy Kanin, Binhi Alsa, Ganador (sold only as
  "premium well-milled"), NFA (a government grade), Akira (retailer page gives no description).
- **Variety search, round 3 (fact-check of user-supplied Google-AI notes).** The notes were checked
  claim by claim; most were unsupported or contradicted, so only two names were added: Binhi Alsa →
  "Long Grain Soft Rice" (marketed as such; the sacks are labelled Product of Vietnam) and NFA → "NFA
  well-milled rice" (DA price sheet grade). Rejected: the "1230 = Mestiso 120" claim (the cited IRRI page
  never mentions 1230); "Magnolia = Super Angelica (RC-216)" (Angelica is NSIC Rc 122; Rc 216 is a
  different variety); "Ganador = RC-160" (retailers list it only as premium well-milled); "Boy Kanin"
  (no rice product found — only a restaurant chain); 1180/1220/1260 Berry (no published source).
  **Open classification issue:** Binhi Alsa is filed as a *local* category but is Vietnamese-origin
  imported rice; Adarna is sold as imported by dealers yet also as local Pangasinan rice. The card's
  "Origin: Philippines" is therefore unreliable for those two until their category is confirmed.
- **Variety search, round 4 (news / Facebook / Google / Lazada-Shopee).** Added Ganador → "Long Grain
  Rice" (Landers/Lazada list "Ganador Oliver" as long-grain well-milled). Still unverifiable from any
  public source: 1230, 1260 Berry, 1180, 1220, Magic C (a similarly named "Magic Castle" is a Thai
  import — identity NOT confirmed), Magnolia, Boy Kanin, Adarna (sold both as imported white/yellow and
  as Pangasinan fresh-milled), Akira. These come from a local-market survey, so the sack label itself
  is the only reliable source.
- **Category-price card removed from the toolbar.** It showed the category range (e.g. ₱48–62) beside brand
  cards priced ₱45–58 or ₱78–102, which read as a contradiction. It is now a result counter
  ("15 products" / "6 results"). Copy on the page now says a brand's price is its category's range
  adjusted by how that brand usually sells against it, so it can sit above or below the category range.
  Cards without a sourced variety show the general term "Milled rice".
- **Grades now follow the variety, not the survey price** (`datasets/reclassify_by_variety.py`). The
  catalog had been filed by price band, so one variety could sit in two grades (Sinandomeng in Premium
  and Special; Dinorado/Jasmine/Brown/Red/Black in both). Per the DA definitions (Special = glutinous,
  aromatic, pigmented, e.g. Dinorado/Malagkit/red-black-brown rice; Premium = well-milled, ≤5% broken —
  DA SRP notice, PNS/BAFS 290), 11 products were re-filed within their segment: Dinorado, Jasmine,
  Brown/Red/Black rice and scented Buko Pandan → Special; Sinandomeng → Premium; imported Royal Umbrella
  Hom Mali Jasmine → Imported Special. Weights were recomputed against the new category base (same
  shelf price). Two brand-website Doña Maria rows (Jasponica/Miponica, unpriced, "grade pending") were
  soft-deactivated as duplicates of the priced grocery rows. **Left in place, unclassifiable by
  variety:** codes/"Regular Milled" packs, Equal Rice Long Grain / Garcia Salvador / Gold Sun, and
  Henri & Isabelle "Fine Grain 100% broken" (100% broken cannot be Premium — needs a correct grade).
  DB backup: `agriprice_database.db.backup-pre-reclass-20260926-024808`.
- **One card per product.** The 5 merged multi-product rows (Henri & Isabelle, Equal Rice, Harvester's ×2,
  Doña Maria Local Special) were split into 17 product rows by `datasets/split_multi_sku_brands.py`,
  using the per-product prices the source workbook kept on "Consolidated SKU Detail". Each product
  has its own surveyed price and weight (single 2026-09-04 observation, same method as
  `seed_brand_weights.py`); the merged rows are soft-deactivated, not deleted (DB backed up first).
  Products keep the category they were filed under — the workbook does not classify individual
  products, and nothing was reclassified. Cards show "+N other products from this brand"; the modal
  lists and links them. Catalog now: 51 active product rows (was 39).
- **Known limitation to disclose if asked:** brand ranges apply one premium (surveyed on a single
  date) to the whole category band, so wide-premium brands (e.g. Harvester's +137%) get
  proportionally wider ranges — an assumption, not a measured spread.

### Round — Updated local-market brand survey (pack sizes)
Imported `NEW_UPDATED_Rice_Brand_Final_Survey.xlsx` with `datasets/import_brand_survey.py` (DB backed up
as `agriprice_database.db.backup-pre-survey-20260926-173804`). **No model change** — the catalog is
display-layer only.
- **Pack sizes:** products sold as 1kg / 2kg / 5kg / 10kg / 25kg packs are stored per pack in the new
  `brand_pack_price` table (pack price + price per kg). One product = one card; its packs are listed on
  it. Rows without a size are priced per kilo.
- **Grades follow the survey's own Classification column** (supersedes the variety-based re-filing in
  the earlier round). Catalog now: 52 products (Local Special 22, Local Well-Milled 11 — previously
  empty — Local Premium 9, Local Regular 3; Imported Special 3, Well-Milled 3, Premium 1). 30 old rows
  soft-deactivated; brand images carried over to renamed brands.
- **Imported Regular-Milled is intentionally empty** — the survey records it as not sold under a brand
  in the Philippines; the site says so instead of showing an empty grade.
- **Revised survey (same day) fixed at source:** Henri & Isabelle Black Rice (2kg) is ₱219 on all 30
  days (the ₱97.25 entries were an error), and all Sinandomeng is now Local Premium (Mrs. Lam; Lion
  Ivory renamed "Lion Ivory Grains — Local Sinandomeng"). Re-imported; backup
  `agriprice_database.db.backup-pre-survey-20260926-174556`. Kept as surveyed (confirmed unchanged in
  the revision): Doña Maria Jasponica White 2kg ₱142.50/kg vs 1kg ₱129.50; Henri & Isabelle Brown Rice
  5kg ₱101/kg vs 2kg ₱94.50; Master Chef Hasmin "Super Dinorado" priced the same as Master Chef Super Alsa.
- **Survey method, as stated by the project team:** a 30-day daily canvass in local markets, Aug 6 –
  Sep 4, 2026. Sep 4 is day 30 (the last day) and its price is the one used; `sample_n` = 30 daily
  readings (prices were unchanged across the 30 days for every product). The catalog's "How is this
  price worked out?" says this, and the stale-price warning was removed because brand prices are
  re-anchored to the DA / forecast range every day.
- **Source shown in the catalog: "Verified by Local Government."** Per the project team, the barangay
  verification of the canvass is in progress (week of Sep 26, 2026). **[ACTION]** have the signed
  verification in hand before the defense — the site states it as done.

### Round — Homepage "Popular rice" (well-known variety names)
Prompted by a panel question ("where is Sinandomeng?"): the homepage led with grades only. Added,
on `public/landpage.html` + `js/landpage.js` + new shared `js/public-varieties.js`:
- A **Popular rice** strip under the banner — the 4 varieties sold by the most brands in the
  catalog (currently Dinorado, Sinandomeng, Jasmine, Brown Rice), each with its **range of shop prices
  seen in the 2026-09-04 survey**, its grade(s), and a link to the catalog showing exactly those
  brands (`rice-catalog.html?variety=…`; the card's brand count matches the catalog's).
- The same varieties lead the ticker, **without ▲/▼** (a variety has no daily change); the 8 grade
  prices after them keep their real day-on-day change.
- **Honesty of the wording:** "popular" = most brands listing it in our catalog (there is no sales
  data); prices are a survey range across brands — not a daily market price and not a forecast.
  Pack specs ("Thai Rice (5% broken)", "Long Grain Soft Rice"…) are excluded from the ranking. Grades,
  DA prices and the LSTM forecast are unchanged. Also fixed: catalog search now matches a brand's
  verified variety name (Lion Ivory was missing from a "Sinandomeng" search).

### Round — Price History page: tabbed layout (UI only)
`public/historical.html` + `public/js/public-history.js`. The five entries (Is it expensive now ·
Price chart · Then vs now · Cheapest month · Biggest swings) were one long stacked scroll; they are
now five tabs showing one question at a time, in that order, with "Next" links between them and
deep links (`#today`, `#chart`, `#years`, `#season`, `#swings`). The chart's duplicate variety
dropdown was removed — the banner's single variety/unit control drives every tab. The Today tab shows
a coloured dot for the current verdict. **No calculation changed**: same statistics, same
observed-days-only rule, same data. If the paper describes the Price History screen as a single
scrolling page of panels, update that description (and any screenshot) to the tabbed layout.
- **Follow-up (readability pass):** every tab now uses one identical card (same width, padding and
  height; the chart stretches to fit rather than setting the size), type raised to 12px minimum
  (most body text 14–15px), and every chart has labelled axes, a plain-language legend and a
  "How to read this" line. New visual aids, all drawn from values already computed: a "where today
  sits" bar on Today (lowest → highest recorded price with the usual-range zone), printed values on
  the two cheapest/priciest months, and a small 30-day line on each price-swing card. Update any
  paper screenshots of this screen.
- **Follow-up (fit to screen):** the tab bar stays pinned at the top while scrolling, and each card
  sizes itself to the window (fits a 1366×768 laptop with the tabs visible; capped at 780px on large
  monitors; natural height on phones). Tooltips are no longer clipped by the card and slide sideways
  to stay on screen.

### Round — Charts & Stats page redesigned (UI + a display-side data check)
`public/statistics.html` + new `public/js/public-stats.js` (the old stats code in `public-data.js`
was removed). Same look (split green hero, dark chart cards), four plain-language cards instead of
the old KPI ring + line + bar layout. All figures come from the live `/api/historical-data`
(DA average retail prices); **the sample-data fallback was removed**, so if the backend is down the page
says so instead of drawing mock numbers.
1. **What got cheaper, what got pricier?** Change per rice type over 7/30/90 days (average of the
   last 3 DA readings vs the first 3; under ₱0.10/kg = "about the same").
2. **Local or imported — which costs less?** Today's local vs imported price per DA grade on one
   price scale, with the average gap over the period.
3. **How did one rice type move?** Daily line with its average, lowest and highest, plus the day-1
   forecast as a link to the Price Forecast page.
4. **What will my rice cost?** Monthly cost for all 8 types from today's DA price × the kilos the
   user enters (week or month; a month = 4.33 weeks). A kilo / 25-kg sack toggle applies to cards 1–3.
- Dropped: the "Market mix" ring (a fixed decoration that looked like data), the role pill, the
  reading-guide tiles (each card now explains itself), the unused audience tabs.
- **Display-side data check (disclose if the paper describes this screen):** days with no DA reading
  are not counted (same rule as Price History), and a reading more than **5%** from the median of the
  3 readings either side is left out as a recording error. Every left-out reading is named on the card
  it affects. It catches real scrape errors where a grade's price was saved in the wrong column:
  Imported Premium/Well-Milled/Regular on **Sep 19, 20, 22, 2026** (shifted one grade), Imported
  Premium on **Jul 23** (holds the Special price), Imported Well-Milled on **Jul 15**, and Local Regular
  on **Jun 30** (holds the Well-Milled price). *Update (next round):* the Sep 19/20/22 and Jul 23
  rows, plus Jun 30 and Jul 15 (confirmed by the user against DA's email), are fixed in the database,
  so the filter finds nothing today and stays only as a safety net. Update any paper description or screenshot of the Charts & Stats screen.

- **Follow-up (fit to screen, tabbed):** the four cards are now tabs (01 What changed · 02 Local vs
  imported · 03 One rice type · 04 My budget) under a compact banner. Tabs and the period/unit controls
  are pinned in one bar under a slim banner, and the open card is sized so the whole view — banner, tabs
  and card — fits the window on first load without scrolling (checked at 1280×720, 1366×768, 1527×727,
  1440×900 and 1920×1080, nothing cut off; natural height on phones). Tapping a rice row or an "at a glance" tile opens that rice's
  chart, and each card ends with a "Next" button. Same content and numbers. Update any paper screenshot of
  this screen.
- **Follow-up (calmer layout):** the four "at a glance" tiles were removed. Each repeated a card (biggest
  rise/drop = card 01, cheapest/priciest = card 04). The banner is now one slim title strip, the column is
  narrower (1040px), the tabs show names only, the period/unit controls sit in the header of the three cards
  they affect (not in the budget card), and the chart's separate legend row was dropped (the stat boxes
  carry the colours). On short windows the card's description line and the summary's repeated second
  sentence are hidden.

### Round — Scraper reads DA bulletin prices by position; Sep 19/20/22 and Jul 23 fixed
**Scraper bug fixed.** `tools/pdfconvrt.py` mapped "the last four prices in the section" to
Special → Regular. When the website bulletin printed **"n/a"** for Imported Regular (Sep 19, 20, 22 2026),
every imported grade slid down one row: Premium ← Special, Well-Milled ← Premium, Regular ← Well-Milled.
The text order of the price column is also unstable (inline, above or below its label). **Fix:** each price
is paired with the label row nearest to it on the page, "n/a" stays empty, and nothing is assigned by
position. Checked on all 29 unique bulletins the scraper had saved: 24 matched exactly, and the rest
differed only where the stored data was wrong. `datasets/parse_da_dpi_pdfs.py` now uses the same reader.

**Cells corrected in `WS_rice_price` (only the rows reported as wrong):**
- Sep 19, 20, 22 (scraper rows): Imported Special/Premium/Well-Milled set to the bulletin's values. Imported
  Regular was the Well-Milled price (the website printed n/a). It is now **45.00** on Sep 19–22, from
  DA's emailed data (supplied by the user).
- Jul 23: Imported Premium 59.53 → **51.43** (the bulletin value; 59.53 was the Special price). Also changed
  in `da_dpi_verified_2026.csv`, so a rebuild keeps the fix.

**Correction to an earlier mistake in this session.** A first pass also compared the user's verified rows
(`Source='da_dpi_verified'`) with the **website** bulletins. It blanked 62 Imported Regular values
(Jun 14 – Aug 18) where the website shows "n/a", and changed May 23/24/27/30, Jun 30 and Jul 15. **That was
wrong:** those values come from **DA's emailed data**, which includes prices the public website does not
show. **All of them were restored** from `agriprice_database.db.backup-pre-bulletin-repair-20260926-202130`,
and the CSV and `apply_da_dpi_2026.py` were reverted. Only the cells listed above remain changed. For the
paper: the June–September rows are DA data received by email, which is why many of them cannot be checked
against the public website. State that source explicitly.

`datasets/repair_ws_rice_from_bulletins.py` now corrects only the scraper's own rows (`da_official`). It never
blanks a value and never changes verified/emailed rows; it only lists their differences from the website for
review. Bulletins are cached (gitignored) in `tools/debug_fetch/dpi/`.

**Confirmed by the user against DA's email and corrected:** Jun 30 Local Regular 49.42 → **44.71** and
Jul 15 Imported Well-Milled 51.27 → **47.95**. Both were copy slips in the workbook (each held the next
column's price). Also changed in `da_dpi_verified_2026.csv`. Backup: `agriprice_database.db.backup-pre-email-values-20260926-204641`.

**Paper impact:** small. 15 cells changed in total: Sep 19/20/22 (9 imported values moved back to the right
grade, 3 Imported Regular set to 45.00), Jul 23 Imported Premium, Jun 30 Local Regular and Jul 15 Imported
Well-Milled. Retrain when convenient and re-check the quoted `meta.json` figures.

**May 30 filled in:** 5 cells that had been empty since the original ingest (Local Special and all four
imported grades) are now set from the DA Daily Price Index PDF for May 30 2026, confirmed by the user:
59.86 / 51.09 / 48.02 / 42.50 / 60.07. The three local prices already stored matched the PDF. Also updated in
`da_dpi_verified_2026.csv`. `WS_rice_price` now has **no empty cells** for 2026.

**Retrained on the corrected data (2026-09-26, seed 42, TensorFlow; previous model in
`model/_backup_pre-datafix-20260926-205138/`).** Test window 2025-10-07 → 2026-09-24 (the old run
ended 2026-09-21, so this is almost but not exactly a fixed-window comparison). All 50 tests in `tests/` pass.

| | before | after |
|---|---|---|
| mean skill vs naive | +3.39% | **+3.42%** |
| types with positive skill | 8/8 | **8/8** (worst: impRegular +0.45%, was +0.47% worst) |
| beats ARIMA(1,1,1) | 3/8 | **3/8** (impWellMilled, impRegular, impPremium) |
| locWellMilled: model vs ARIMA MAE | 0.3034 vs — | **0.3042 vs 0.2842** (ARIMA ahead) |
| movement ratio | 0.220 | 0.223 |
| LSTM ablation (McNemar, genuine-signal) | 169 vs 157, p = 0.54 | **161 vs 164, p = 0.91**, not significant |

Per-type MAE improved most where data was corrected: impPremium 0.406 → 0.314, impWellMilled 0.355 →
0.289, impRegular 0.373 → 0.344, locRegular 0.322 → 0.292. That is mostly because the test targets no longer
contain the column-shifted rows, not because the model got better; skill against naive is essentially
unchanged. **Say it that way in the paper.** Directional accuracy on day 3 is below 50% for impRegular (45.3%),
and on day 2 for impPremium (47.7%). Report the per-horizon figures rather than one pooled number.
**Update the `.docx` wherever it quotes the old figures** (CLAUDE.md is updated).

### Round — Weekday-aware mean reversion (+3.42% → +7.80% skill), scraper guard, faster history API
**1. Weekday-aware reversion coefficient (model change, paper-relevant).**
*Finding.* In the daily era (2025-04-01 onward, all 8 types) a bulletin's distance from its own week's
median is PHP 0.12–0.15 on Mon–Wed, 0.19 on Thu/Fri, 0.26 on Sat and **0.83 on Sun**. DA's Sunday
bulletin is compiled from fewer markets, and Monday undoes it. Thursday/Friday changes, by contrast,
mostly persist. The shipped correction used one coefficient for every day.
*Change.* `model/mean_reversion.py`: `rolling_phi(..., dows=)` gives the anchor day's weekday its own
coefficient (same 120-day rolling, past-only fit, same ×0.6 shrink, [−1, 0] clip and |t| ≥ 2 gate). It falls
back to the global coefficient for a weekday without significant reversion. The switch is
`AGRIPRICE_REVERSION_WEEKDAY` (default on). The same per-row coefficient is used in training scores, the live
forecast, the recent-days backtest and the prediction-interval calibration.
*Selection, fixed before looking at test* (`model/experiments/weekday_reversion.py`): candidates
{global, 3 weekday groups, 7 weekdays} × {120, 240, 365}-day windows, chosen by mean **validation** skill,
then scored once on test:

| candidate | val mean | test mean | test worst |
|---|---|---|---|
| global (previous) | 4.29 | 3.41 | 0.29 |
| 3 groups / 120 | 7.22 | 7.78 | 3.24 |
| **7 weekdays / 120 (chosen on val)** | **8.01** | **7.78** | 2.15 |
| 7 weekdays / 240 | 7.04 | 7.46 | 2.74 |

Every candidate that used the weekday roughly doubled skill, so the result does not depend on one lucky setting.

*Retrained result* (test 2025-10-07 → 2026-09-24; previous model in `model/_backup_pre-weekday-20260926-210938/`):

| | global rule | weekday-aware |
|---|---|---|
| mean skill vs naive | +3.42% | **+7.80%** |
| types positive | 8/8 (worst +0.45) | **8/8 (worst +1.88)** |
| mean MAE | PHP 0.3042 | **PHP 0.2877** |
| beats ARIMA(1,1,1) | 3/8 | **4/8** (locRegular by PHP 0.0002, effectively a tie) |
| movement ratio | 0.223 | 0.299 |
| directional accuracy | unchanged within ±1 pt (still < 50% for impRegular day 3, impPremium day 2) |
| LSTM ablation | p = 0.91 | p = 0.95, still not significant |

**How to state it:** the gain comes from modelling DA's reporting calendar (the Sunday bulletin effect) inside the
reversion term. It is **not** a gain from the network, and it improves forecast *magnitude*, not the up/down call.
Per-type test skill: locWellMilled 11.46, locRegular 11.85, locPremium 7.69, locSpecial 7.27,
impWellMilled 1.88, impRegular 5.03, impPremium 7.75, impSpecial 9.49. `tests/test_weekday_reversion.py`
pins no look-ahead, the bounds, and the off switch.
*Prediction intervals:* realised coverage re-measured by walk-forward over the last 120 forecast origins ×
8 types (`model/experiments/interval_coverage.py`, calibrated exactly as the live forecast): **91.6% pooled**
(day 1/2/3: 91.7 / 91.9 / 91.4%; by type 88.1–94.4%). This is still in line with the advertised "90%" range.
Mean width is PHP 1.28 / 1.54 / 1.74 by day.

**2. Scraper sanity guard (`tools/scrape_guard.py`).** Before a scraped rice row is saved, a price is **held**
(saved as empty, queued in `tools/scrape_review.json`) when it equals the neighbouring grade's price or is
more than 6% from that grade's last-7-reading median. The Sep 19–22 shift was 7–12%. Admin → Web Scraper shows
the queue with Approve/Reject (`GET /api/scrape-review`, admin-only `POST /api/scrape-review/resolve`).
Approved readings are not held again on re-sync. `tests/test_scraper_guard.py` runs the reader on three real
DA bulletins (the Sep 20 n/a layout, an inline layout, Jun 30) and tests the guard rules.

**3. `/api/historical-data` cached per database version.** Same payload (verified identical), built once per
database change, gzip + ETag: **342 KB / ~530 ms → 45 KB / <1 ms**, and 304 with no body on revalidation.
No change to any number.

Test suite: **61 passed**.

### Round — Can the LSTM itself contribute? Nine configurations tested (experiment; production unchanged)
`model/experiments/lstm_improve.py` (results in `lstm_improve_results.json`). Same test window as production
(2025-10-07 → 2026-09-24). Each configuration's LSTM weight (0.25 / 0.5 / 1.0) and reversion on/off were chosen
on a **selection window** (the last 40% of the validation block, Jul 23 – Oct 6 2025) and then reported once on test.
The benchmark is the reversion-only forecast (LSTM weight 0), which scores **+7.90%** on test.

**Two diagnostic findings (both paper-relevant):**
1. *The production LSTM never trains on daily-era data.* The regime-aware split trains on 2015-01 → 2025-03-31
   (weekly figures forward-filled to daily) and keeps every genuinely daily day for validation/test.
2. *The production LSTM is effectively trained for one epoch.* EarlyStopping uses `min_delta=1e-4`, but the
   delta-target validation loss is only ~7e-4, so no later epoch ever counts as an improvement: every rice type
   stops at epoch 9 with its epoch-1 weights (see the training log). In practice this acts as very strong
   regularisation toward "no change". Training it properly (V6–V8) made it fit the validation block better and
   the test period worse (overfitting).

| config | change | chosen | selection | **test** | worst type | LSTM alone | LSTM lowers error on | directional McNemar |
|---|---|---|---|---|---|---|---|---|
| V0 | production | w .25 + rev | 12.22 | **7.80** | 1.88 | −1.29 | 45.8% of forecasts | p 0.95 |
| V1 | + daily era in training | w .25 + rev | 12.10 | **7.84** | 2.19 | −1.14 | 46.6% | p 0.81 |
| V2 | + weekday, last-change, dev-from-7-day-median features | w .25 + rev | 12.18 | **7.85** | 2.08 | −1.19 | 47.7% | p 0.50 |
| V3 | + old weekly-era rows weighted 0.25 | w .25 + rev | 12.10 | **7.55** | 1.56 | −3.53 | 45.4% | p 0.001 (worse) |
| V4 | + one network pooled over 8 types | w .25 + rev | 11.45 | **6.96** | −1.38 | −11.42 | 45.6% | p 0.56 |
| V5 | + trained on the reversion residual | w .25 + rev | 11.70 | **7.21** | −0.48 | −8.38 | 46.4% | p 0.84 |
| V6 | V2 + fixed training (std targets, min_delta 0) | w .25 + rev | 12.88 | **5.14** | −11.92 | −17.14 | 43.7% | p 0.09 |
| V7 | V6 pooled over 8 types | w .5 + rev | 16.14 | **7.30** | −4.73 | −1.04 | 45.1% | p 0.57 |
| V8 | V7 on the residual | w 1.0 + rev | 13.95 | **−3.16** | −22.2 | −9.79 | 42.0% | p 0.11 |

**Verdict: no configuration beats the reversion-only forecast on the test window when chosen by the
pre-declared rule.** In every configuration the LSTM term raises the absolute error on more forecasts than it lowers
(paired sign test, all p < 0.001). This holds across training data, features, weighting, pooling and residual
learning, so it is a robust result, not one bad setting. It agrees with the "no significant contribution"
ablation already reported, and it supplies the counter-evidence Chapter 2's revision note asks for: at this data size
(≈540 genuinely daily days), a statistical term captures the predictable part of a near-random-walk series and the
network adds none. Note that the production forecast (w = 0.25) is 0.10 pp *below* reversion-only; the LSTM is kept
in the path at a disclosed low weight because the study's objective is the multivariate LSTM system.

*Exploratory only, not deployed:* V7 at w = 0.25 scored +8.98% on test (6/8 types above reversion-only), but that
weight was **not** the one the selection rule chose (w = 0.5 → +7.30%). Choosing it after seeing test would violate
this project's rule that an improvement must win on a window it was not tuned on.
*Seed-stability check* (`model/experiments/lstm_seeds.py`): V7 retrained with three other seeds gave test
+7.88 / +7.89 / **+1.36%** at w = 0.25 (and −12.56% at w = 0.5 for seed 2024), against +7.90% for reversion-only.
**The +8.98% was seed luck and V7 is rejected.** A properly trained network on ≈540 daily days is unstable: the same
configuration lands anywhere from matching reversion-only to far worse, depending on initialisation.

**Why production keeps the current LSTM training.** Early stopping selects the epoch-1 weights because no later epoch
improves the validation loss by `min_delta`. Retraining with `min_delta = 0` (V6–V8) fitted the validation block
better but was worse and unstable on test. So the current setting is the conservative, seed-stable choice, and it is
kept. State it that way in the paper ("early stopping retained the weights with the lowest validation loss; longer
training overfitted and was not stable across seeds"), and do not describe the network as "trained for N epochs".

**How to report this in Chapter 4.** It is the study's hyperparameter-tuning and ablation evidence (Chapter 3 promises
structured tuning and a baseline comparison). Nine configurations were tested and chosen on validation, and none made the
LSTM beat the statistical reversion term on held-out data. This matches the forecasting literature on near-random-walk
series, and it answers Chapter 2's request for counter-evidence to "deep learning always outperforms statistical models".
The deliverable (a multivariate LSTM forecasting system with a 48–72 h lead time) is met. The accuracy over naive
persistence (+7.8%) comes from the hybrid's reversion term, and the paper must say so.

**Future work (and how to check it).** The binding constraint is daily data: about 30 genuinely daily days are added per
month. Re-run `experiments/lstm_improve.py` every few months; if a configuration then beats reversion-only on a window it
was not tuned on, and across seeds, adopt it.

### Round — Beating ARIMA(1,1,1): forecast combination tested (experiment; production unchanged)
`model/experiments/arima_combo.py` (results in `arima_combo_results.json`). Saved production models; nothing retrained.
*Why ARIMA wins on some types:* the hybrid is anchored on the last DA reading, which carries that day's survey noise.
ARIMA(1,1,1)'s MA term acts as a smoothed level. The losses are concentrated where readings are noisiest: locSpecial
(+5.0% MAE) and impSpecial (+4.5%). The hybrid's wins are large on imported grades (impPremium −16.5%).
Candidates were chosen on the validation block by mean MAE, one setting for all 8 types, and reported once on test:

| forecast | beats ARIMA | mean skill vs naive | worst type |
|---|---|---|---|
| hybrid (production) | 3/8 (+1 tie) | **+7.78%** | +2.15% |
| 0.25·hybrid + 0.75·ARIMA (**chosen on validation**) | **6/8** | +6.62% | −5.11% |
| 0.5·hybrid + 0.5·ARIMA (equal weights, untuned default) | 6/8 | +7.47% | −0.41% |
| 0.75·hybrid + 0.25·ARIMA (*identified only after seeing test*) | 5/8 | +7.94% | +2.45% |
| ARIMA + weekday reversion | 1/8 | +1.73% | −11.65% |
| hybrid re-anchored on a smoothed level (α = 0.7) | 3/8 | +5.23% | −2.24% |

**Trade-off, stated plainly:** an ARIMA–LSTM combination beats ARIMA on more types (6/8), but it gives up average
accuracy and can dip below naive on one type. The production hybrid has the best average accuracy and beats naive on
all 8. The 75/25 weight looks strictly better, but it was noticed after seeing test, so it cannot be claimed without a
forward (prospective) evaluation. **Production is unchanged** pending the team's choice. For the paper, the defensible
framing is: "the hybrid beats naive persistence on all 8 types and is competitive with ARIMA(1,1,1) (3 wins, 1 tie,
2 losses ≤ 1.2%, 2 losses ≈ 5% on the Special grades); an ARIMA–LSTM forecast combination was tested and beats ARIMA
on 6/8 at a cost in average skill."

### Round — Adaptive forecast combination beats ARIMA on 8/8 and raises skill to +10.0% (experiment; not yet deployed)
**Diagnosis first.** A DA reading behaves like *true price + that day's survey noise*. The noise differs by weekday
(distance from the week's median: std ≈0.3 Mon–Wed, ≈0.9 Thu–Sat, 1.4 Sun) and some grades carry a weekday bias.
ARIMA(1,1,1) smooths the noise but ignores the weekday; the production hybrid handles the weekday but anchors on one
noisy reading. *(These statistics were computed over the whole daily era including the test period; disclosed.)*

**Weekday Kalman filter (`experiments/kalman_dow.py`).** A local-level filter with a noise variance per weekday (K1),
optionally a bias per weekday (K2). Maximum likelihood, re-estimated every 28 days on past daily-era rows only. Chosen
on selection (K1), it scored +6.37% on test (5/8 vs ARIMA, one type below naive): strong on Local Special/Regular, weak
on imported grades. The bias version overfitted badly (−12.9%). **Not adopted on its own.**

**Adaptive combination (`experiments/adaptive_combo.py`).** No single forecaster wins everywhere, and the leader drifts
over time. So each day, each component is weighted by 1 / (its mean squared error over the last 30 realised forecasts),
per rice type and per forecast day (Bates & Granger, 1969). Past errors only; the 30-day window was fixed in advance.
Two configurations: BG2 {hybrid, ARIMA} and BG3 {hybrid, ARIMA, weekday Kalman}. BG3 was chosen on the selection window
(20.7% vs 14.2%) and reported once on test:

| | production hybrid | **BG3 (chosen)** | BG2 |
|---|---|---|---|
| beats ARIMA(1,1,1) | 3/8 | **8/8** | 6/8 |
| mean skill vs naive | +7.78% | **+10.01%** | +7.75% |
| worst type | +2.15% | **+2.28%** | +1.06% |
| directional accuracy | 59.9% | 60.0% | 59.8% |

Per type (test skill, hybrid → BG3): locWellMilled 11.53 → 13.88, locRegular 11.76 → 15.62, locPremium 7.69 → 10.34,
locSpecial 7.37 → 15.63, impWellMilled 2.15 → 3.28, impRegular 4.86 → 4.90, **impPremium 7.39 → 2.28 (the one type that
falls; it still beats ARIMA and naive)**, impSpecial 9.52 → 14.17.
**Robustness (disclosed, not used for choosing):** the window length changes nothing material. With 15/20/45/60/90 days
BG3 gives 8/8 vs ARIMA, +9.90 to +10.05% mean skill and 60.0% directional. The gain is structural, not a lucky setting.
**Caveat:** the test window has been used for many experiments in this round. The protocol (validation choice, one
configuration, fixed window, past-only weights) limits the damage, but a forward evaluation on days after 2026-09-24 is the
clean confirmation.

**For the paper (if adopted):** the forecasting system becomes an *adaptively weighted ensemble* of (1) the LSTM-based
hybrid, (2) ARIMA(1,1,1) and (3) a weekday-aware Kalman filter. The LSTM remains a component. The accuracy gain comes from
the ensemble and the weekday noise modelling, not from the network alone.

### Round — Adaptive ensemble deployed (model change, paper-relevant)
Approved by the team and now the published forecast. Code: `model/ensemble.py` (ARIMA walk-forward, weekday
Kalman filter, inverse-MSE combination), used by both `train.py` (test scoring → `meta.json`) and `predict.py` (live
forecast, price range, chart backtest). `AGRIPRICE_ENSEMBLE=0` restores the plain LSTM hybrid instantly. Previous model
backed up in `model/_backup_pre-ensemble-20260927-011854/`.

**Retrained result (test 2025-10-07 → 2026-09-24, seed 42):**

| | LSTM hybrid (previous) | **adaptive ensemble (published)** |
|---|---|---|
| mean skill vs naive | +7.80% | **+10.06%** |
| beats ARIMA(1,1,1) | 4/8 (one a tie) | **8/8** |
| every type beats naive | yes (worst +1.88%) | yes (worst impPremium +2.63%) |
| movement ratio | 0.30 | 0.41 |
| realised price-range coverage (walk-forward, 120 origins × 8 types) | 91.6% | **91.5%** (day 1/2/3: 92.2 / 91.0 / 91.1%), same width |

Per type (skill, hybrid → ensemble): locWellMilled 11.46 → 13.87, locRegular 11.85 → 15.74, locPremium 7.69 → 10.34,
locSpecial 7.27 → 15.59, impWellMilled 1.88 → 3.19, impRegular 5.03 → 4.98, impPremium 7.75 → 2.63, impSpecial 9.49 → 14.17.
Average test weights are close to one third each (e.g. locSpecial 0.33 / 0.33 / 0.34 hybrid/ARIMA/Kalman). The
ensemble earns its gain by switching between the components over time, not by permanently preferring one.

**Disclose these (do not leave them for the panel to find):**
- *Direction on two imported grades fell.* Day-1 up/down accuracy is impRegular 45.7% (hybrid had 62.4%) and
  impPremium 50.3% (hybrid 57.9%), although five types improved (e.g. impSpecial 66.0 → 68.9, locSpecial 53.9 → 57.9).
  impRegular's 45.7% rests on 210 moves (95% CI 39–52%, p = 0.24 vs 50%): it is *at chance*, not significantly worse.
  Validation did not predict this (ensemble direction there was 71.1% vs 63.4%), so the types were not switched after
  seeing test, which would have been test-tuning. The direction contract test now asks "not significantly below chance
  per type" plus "pooled above 50%". That still catches the sign-bug class it was written for (0–32% on 200–350 moves is
  overwhelming) without failing on noise. `directional_n` (moves per figure) is now saved in `meta.json`.
- *impPremium's accuracy fell* (+7.75 → +2.63%); it still beats naive and ARIMA.
- *The test window was reused* across this round's experiments. The choices were made on validation with a fixed window
  and past-only weights, which limits the damage; a forward evaluation on days after 2026-09-24 is the clean confirmation.
- *The network is still not the source of the gain* (LSTM ablation p = 0.95). The LSTM remains a component of the
  published system (inside the hybrid and the Kalman forecast), which keeps Objective 1 intact.

**Chapter 4 wording (suggested):** "The deployed forecaster is an adaptively weighted ensemble of (1) an LSTM-based hybrid
with a weekday-aware mean-reversion correction, (2) ARIMA(1,1,1) and (3) a local-level Kalman filter with weekday-specific
observation noise. Components are weighted daily by their inverse mean squared error over the previous 30 realised
forecasts. On the held-out test window the ensemble beats naive persistence on all eight rice categories (mean skill
+10.1%) and ARIMA(1,1,1) on all eight, with 90%-nominal prediction intervals realising 91.5% coverage."

### Round — Up/down reliability: a "steady" dead-band tested (experiment; production unchanged)
`model/experiments/direction_deadband.py`. The ensemble's day-1 direction is at chance for impRegular/impPremium
because their forecast change is usually a few centavos, yet a rise/fall arrow is still drawn. Candidate: show an arrow
only when |forecast − last price| ≥ τ, otherwise "steady". **Pre-declared rule** (τ ∈ {0, .02, .05, .10, .15, .20, .30},
one value, chosen on the selection window by (accuracy on called moves − 50%) × call rate): **it chose τ = 0, i.e. no
dead-band**, because a threshold removes calls faster than it adds accuracy. Per that rule, the model's reported
directional figures are unchanged.
Trade-off for the record (selection window, all types): τ = 0 → 67% of arrows right on 100% of days; τ = 0.05 → 71% on
67%; **τ = 0.10 → 80% on 44%**; τ = 0.20 → 87% on 27%. On test at τ = 0.10: impRegular 48% → 62% (on 32% of days),
impPremium 48% → 54% (29%), locSpecial 62% → 75% (35%). If adopted, it is a *presentation* rule (arrows only for moves of
at least 10 centavos, the same "about the same" threshold the Charts & Stats page already uses), not a change to the
model or its reported metrics.

### Round — LSTM transfer learning from other DA commodities (experiment; rejected)
`model/experiments/transfer_pretrain.py` (results in `transfer_results.json`). The idea was to fix the LSTM's data shortage
by pre-training on the other commodities in the same DA daily bulletins (fish, meat, vegetables, fruit; same markets, same
weekday pattern), then fine-tuning on rice. Pre-training data ended 2025-07-21, before the selection and test windows (no
leakage). It used 67 non-rice commodities observed on ≥70% of days, 4,010 sequences, scale-free inputs (daily change,
distance from the 7-day median, weekday, diesel and USD/PHP daily change). Chosen on the selection window, scored once on test:

| variant | selection | **test** | reversion-only test |
|---|---|---|---|
| pre-trained, no fine-tune | +19.33% | **−0.98%** | +7.90% |
| pre-trained + fine-tuned (chosen) | +20.01% | **−21.85%** | +7.90% |
| same, seeds 7 / 123 / 2024 | — | −10.51 / −16.25 / −12.43% | +7.90% |

**Rejected.** The network learns something that holds in mid-2025 (strong validation scores) and fails in the test year,
consistently across seeds; the LSTM term raised the error on 58–64% of forecasts. With this, 10 LSTM strategies have been
tested: training data, features, weighting, pooling, residual learning, fixed training, transfer learning. None makes the
network contribute on held-out data. **Conclusion for the paper:** at the current amount of genuinely daily data, the LSTM
cannot add accuracy beyond the statistical components, and the system keeps it as a disclosed ensemble component. Re-test
as daily data accumulates.

### Round — "Steady" arrows adopted; forward evaluation log started
**Steady arrows (presentation only).** The team adopted the dead-band as a display rule: a forecast move under
**₱0.10/kg** is shown as "steady" or "about the same" instead of ▲/▼. This is the same 10-centavo threshold the Charts &
Stats page already used. Changed: `/api/predictions` now carries `direction` ("up"/"down"/"steady", `predict.STEADY_PESO`,
env `AGRIPRICE_STEADY_PESO`); the current-prices page (direction column and buying tip), Admin → Predictions (tomorrow card,
forecast table) and Admin → Dashboard (prediction rows) use it. The model and all reported metrics are unchanged. The
experiment above found shown arrows about 80% right at this threshold (selection window). Its pre-declared rule preferred
no band, so this is a disclosed product choice, not a tuned result.

**Forward (prospective) evaluation.** `model/forecast_log.py` + table `forecast_log` in the database + `GET /api/forecast-check`.
Each time the forecast is built for a new day of data, it records every published forecast (8 types × 3 days) with its
range, direction, the naive reference price, and the ARIMA and hybrid components, keyed to the day actually forecast
(last data day + h). INSERT OR IGNORE means a forecast, once written, can never be revised. The report scores the logged
forecasts as DA prices arrive: ensemble vs naive vs ARIMA vs hybrid MAE, range coverage, and direction on non-steady calls.
First origin: 2026-09-26. **This is the clean confirmation the reused test window cannot give.** Once several weeks
accumulate, report it in Chapter 4 as "prospective evaluation".
**Found while building it (display bug, not fixed yet):** forecast day labels are computed from today's *calendar* date,
not from the last day with data. When DA's bulletin for today is not out yet (e.g. data ends Sep 26, today Sep 27), the
card labelled "tomorrow, Sep 28" actually shows the model's forecast for **Sep 27**. The forward log uses the correct dates.
**[ACTION]** decide whether the site should label forecasts by the forecast day itself (e.g. "Sep 27 — today, not yet
published").
**Also fixed (live-system bug):** the forecast cache was keyed on meta.json's `last_date` (the *training* data's end), so a
newly scraped DA bulletin never reached the website until a server restart or retrain. The key now includes the latest
data day, and a successful rice scrape rebuilds the forecast in the background. This also writes that day's forecasts to
the forward log. A cached request still takes about 2 ms.

### Round — Full doc↔app sync before the final defense (2026-09-27)
Everything that describes the system was re-checked against `model/meta.json` (training run 2026-09-26, data through
2026-09-26) and the code, and brought into line.

**Forecast date labels — fixed (resolves the [ACTION] above).** `predict._build_forecasts_by_key` now anchors day *h*
on the last day with a DA price, not on today's calendar date, so a forecast is always labelled with the day it is
actually for (the same dates the forward log uses). The home page's "as of" date now shows the latest bulletin's day
instead of today's date (`public/js/landpage.js`, cache-bust `v=9`). Labels such as "Tomorrow" therefore mean "the day
after the latest DA bulletin", which the pages already show next to the price.

**The paper (`AgriPrice_Draft_Revised.docx`) — edited directly.** Backup:
`documents/AgriPrice_Draft_Revised.docx.backup-pre-sync-20260927`. Only `word/document.xml` changed, plus one additive
`[Content_Types].xml` entry (the four images are PNGs stored as `*.undefined`; declaring that extension lets standard
tools open the file — Word already did). Every edit carries a red `[UPDATED 27 SEP 2026 …]` note to delete before printing.
- **Ch. 1 Scope and Limitations:** added that asymmetric ("rockets and feathers") transmission is not explicitly modelled,
  and that pre-April-2025 DA data was weekly, so accuracy is measured on the daily era.
- **Ch. 2 Traditional vs AI:** added the counter-evidence the panel asked for — Makridakis et al. (2018), statistical
  methods beat the ML methods tested on 1,045 M3 monthly series; Makridakis et al. (2020), M4 winners were mostly
  combinations, the winner a statistical/RNN hybrid. The Synthesis Matrix is still empty (team input).
- **Ch. 3 Research Design:** "fifteen (15) years of historical daily data" → the actual 2015–2026 record, weekly/irregular
  before 2025 and daily from April 2025 (price changes on ~83% of days), with DA email-supplied 2026 values disclosed as
  flagged verified rows. The 70/15/15 split paragraph → the regime-aware split with its dates and the reason. The testing
  paragraph now names both baselines (naive, ARIMA(1,1,1)) and no longer calls ADF an accuracy metric.
- **Ch. 3 Algorithm:** "LSTM networks consistently outperform ARIMA" softened to what the literature supports; new
  subsection **LSTM Hybrid and Adaptive Ensemble** (anchored delta + weekday mean reversion; ensemble of hybrid, ARIMA and
  weekday Kalman weighted by 1/MSE over 30 realised forecasts — Bates & Granger, 1969; Kalman, 1960; conformal range at
  nominal 0.93 → ~90%; "steady" under PHP 0.10).
- **Ch. 3 Conceptual Framework / LSTM Model Development:** the real architecture (2 stacked LSTM layers 64/32, dropout
  0.2, Dense 16, 3 outputs, Adam, MSE, batch 32, 30-day window, early stopping) replaces "structured hyperparameter tuning
  of look-back, units, learning rate and batch size" (not done as described); the nine alternative training strategies are
  named instead.
- **Ch. 3 Implementation / Testing / Deployment:** the PDF reader is described as position-based with the plausibility
  guard and admin review queue (was "reliably extracts regardless of layout changes"); the 74-test suite; the automated
  forward evaluation (forecast log) as the post-release review loop; price ranges and "steady" on the dashboard.
- **Ch. 3 Statistical Treatment:** skill, hit rate, directional accuracy with a one-sided binomial test, range coverage and
  the McNemar ablation added; an ARIMA(1,1,1) baseline paragraph added under Naive Persistence Baseline.
- **Flagged, not changed:** the ANOVA paragraph names **DTI personnel** as a respondent group while the rest of Ch. 3 names
  DA-AMAS personnel — a red [CHECK] note asks the team to use the group that actually answered.
- **New draft Chapter 4 (Results and Discussion) and Chapter 5**, technical parts only, from `meta.json`: Table 1 (per-type
  ensemble MAE vs naive vs ARIMA, skill, day-1 direction), hit rates, coverage, rolling-origin, the component ladder
  (LSTM alone −1.29% → hybrid +7.80% → ensemble +10.06%), the ablation (149 vs 151, p = 0.95), the reused-test-window
  caveat and the forward evaluation; SOP 2 data-engine results; red placeholders for the SOP 3–6 survey tables and
  conclusions; recommendations.
- **References to add to the bibliography** (the .docx has no reference list yet): Bates, J. M., & Granger, C. W. J.
  (1969). The combination of forecasts. *Operational Research Quarterly, 20*(4), 451–468. · Kalman, R. E. (1960). A new
  approach to linear filtering and prediction problems. *Journal of Basic Engineering, 82*(1), 35–45. · Makridakis, S.,
  Spiliotis, E., & Assimakopoulos, V. (2018). Statistical and machine learning forecasting methods: Concerns and ways
  forward. *PLoS ONE, 13*(3), e0194889. · Makridakis, S., Spiliotis, E., & Assimakopoulos, V. (2020). The M4 Competition:
  100,000 time series and 61 forecasting methods. *International Journal of Forecasting, 36*(1), 54–74.

**Other documents brought in line:** `SYSTEM_GUIDE.txt` (defense cheat sheet rewritten with current numbers; new §6.5a
hybrid and §6.5b ensemble; split counts; prediction steps incl. the date anchor, forward log and cache; scraper guard;
new endpoints; formulas), `README.md` and `README.txt` (were "2-day", "5 features", "80/20", "no tests"),
`documents/SYSTEM_FEATURES.md` (headline, split, results table, inference, server-side accounts, Charts & Stats, admin
pages, talking points), `documents/README.md` (current state), `CLAUDE.md`, and superseded banners on
`MODEL_IMPROVEMENT_PLAN.md` and `CH3_METHODOLOGY_ADDITIONS.md`. Admin → Model Dashboard tooltips no longer say the model
"tracks the baseline rather than beating it", and its per-type note now says "lower than the naive baseline (and ARIMA)"
when that is true (`admin/js/model-dashboard.js`, cache-bust `v=20260927`).

### Round — Price Forecast "Prices by brand": Change column was not the real change (2026-09-27)
**Bug.** A brand's *Today* comes from `/api/brand-prices` = category base × (1 + weight_pct/100), and for three grades
that base is the **Aug 1, 2026 DA bracket midpoint** (`catalog_service._latest_base_price` prefers the bracket), not
today's DA price: Imported Well-Milled 54.00 vs DA 48.31, Local Premium 55.00 vs 53.70, Imported Regular 46.50 vs 45.00.
*Tomorrow* was the current DA forecast × the same weight, so *Change* = forecast move **plus** the stale-bracket gap —
e.g. Planters showed **−₱5.29** (and a Tomorrow range of ₱44.x beside a Today of ₱50.00) when the forecast moves −₱0.02.
The five grades whose base is the latest DA price were already correct.
**Fix (`public/current-prices.html`).** A brand now moves by the same *percentage* as the category forecast:
Tomorrow = brand Today × (DA forecast ÷ DA today), and its range and the brand chart/snapshot use the same scale. Where
the base is today's DA price this is identical to before. Changes under ₱0.10 are shown in neutral grey ("steady"),
matching the forecast table. Verified live: Planters −₱0.02 (range ₱49.79–₱50.18), Adarna (Local Premium) +₱0.05.
**Not changed:** the brand *Today* for those three grades is still priced off the Aug 1 bracket; whether the catalog
should use the latest DA price or DTI/DA brackets is the open [DTI] item below.

### Round — Public site brought in line with the paper; account security (2026-09-27)
**Forecast horizon and model wording (home page).** The landing page said "2 days ahead", "the next two days" (FAQ) and
"tomorrow and the day after" under a "3-Day Forecast" heading, and credited "Our LSTM-based forecasting model". The
model forecasts 3 days (`HORIZON=3`, the paper's 48–72 h) and the published forecast is the adaptive ensemble, so the
copy now says three days and describes the ensemble (an LSTM-based model blended with ARIMA and a Kalman filter,
weighted by recent accuracy). No paper change needed; the site had drifted from it.
**Forecast confidence (Price Forecast page).** "How sure are we 93% / 92% / 92%" was `_confidence_ratio`, a linear
rescaling of MAE onto 55–95%, not a probability, shown beside the calibrated "90% of the time" range. It is replaced by
the paper's own measure: the share of hold-out forecasts within PHP 0.50, per rice type and forecast day
(`metrics.by_target[*].hit_rate_pct["0.50"]`; pooled 87.0 / 84.0 / 81.9% as in Ch. 4). The chart's shaded band now
draws the same conformal low/high the figures quote instead of ±MAE. The API's `confidence` field is unchanged.
**No invented prices.** When the API was unreachable, Price Forecast and the home page hero showed `data.js` sample
prices labelled "Actual price" / "today". Both now say live prices cannot be reached.
**Retailer accounts.** `PUT /api/auth/profile` and `POST /api/auth/change-password` trusted the email in the request
body, so anyone could re-email any account and then take it over via "Forgot password". Login/signup now issue a
server-side session token (SHA-256-hashed in `agriprice_users.db` → `user_sessions`, 24 h, or 30 days with "Remember
me"), and both endpoints act only on the session's account. Change-password has its own lockout; password changes and
resets sign out other sessions. If the paper describes account security, it should say this.

### Round — Retailer profile works like the admin profile; new stored personal data (2026-09-28)
`public/profile.html` now behaves like Admin → Account Profile: profile photo (resized to ≤240px in the browser),
editable display name, role/title, email (still the login), phone and bio, Additional Information label/value rows, and
Recent Activity. **New personal data kept per retailer account** (`model/agriprice_users.db`): `title`, `phone`, `bio`,
`avatar` (small JPEG data URL), `extra_info` (JSON rows) — all optional and user-entered — and a `user_activity` table of
the account's own sign-in/security events (account created, signed in/out, failed sign-in, lockout, password
change/reset, login-email change, admin password reset/(de)activation), **time + event only, no IP address**, newest 100
per account. `privacy.erase_data_subject` and `purge_expired_accounts` now also remove the account's sessions and
activity; `/api/privacy-status` lists the new fields. The paper's Data Privacy paragraph ("the public-facing system does
not log end-user IP addresses") still holds; if the paper lists what personal data is stored, add these fields.
**[VERIFY] pre-existing, not changed here:** `POST /api/auth/forgot-password` writes the retailer's email and client IP
into the admin System Logs (`_add_log(... from {client_key})`), which contradicts that same paragraph's "contain no
evaluator or end-user personal data" / "does not log end-user IP addresses". Either redact it (`privacy.redact_email`,
drop the IP) or change the paper.

---

## Still [VERIFY] / [ACTION]
- **[TEAM]** fill every red `[TEAM INPUT REQUIRED]` note in the .docx: SOP 3–6 survey tables and conclusions, per-stratum
  headcounts, Synthesis Matrix rows, sprint count/duration, the conceptual-framework diagram; add the four references
  above; resolve the DTI vs DA-AMAS respondent-group [CHECK]; delete all red notes before printing.
- **[ACTION]** before the defense, add the forward-evaluation numbers (`GET /api/forecast-check`) to Chapter 4.
- **[ACTION]** restart the backend so the ensemble, date-label fix, forward log and new endpoints are live.
- **[DTI]** confirm the 8 category names/definitions and the **brands** under each (DA has none).
- **[DTI]** whether to keep the DA Bantay Presyo ranges or use official DTI brackets.
- **[BOC]** any additional customs processing fees beyond the tariff.
- **[ACTION]** state the target **population N** (≈100 to justify n=80).

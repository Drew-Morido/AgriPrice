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

## Still [VERIFY] / [ACTION]
- **[DTI]** confirm the 8 category names/definitions and the **brands** under each (DA has none).
- **[DTI]** whether to keep the DA Bantay Presyo ranges or use official DTI brackets.
- **[BOC]** any additional customs processing fees beyond the tariff.
- **[ACTION]** state the target **population N** (≈100 to justify n=80).

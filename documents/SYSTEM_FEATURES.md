# AgriPricePH — System Features & How It Works
### A study guide for the thesis defense

This document explains **every feature** of AgriPricePH and **how it works internally**, so you
can answer panel questions with confidence. It reflects the code as built (not aspirational).
Pair it with `PAPER_CORRECTIONS.md` (doc↔app reconciliation) and `CH3_METHODOLOGY_ADDITIONS.md`.

---

## 0. What the system is (elevator pitch)
AgriPricePH is a **Philippine (NCR) rice price monitoring and short‑term forecasting** web system.
It collects rice, fuel, exchange‑rate, stock, and farmgate data into a local SQLite database,
trains a **multivariate LSTM per rice type** to forecast retail prices **3 days (48–72h) ahead**,
and serves both a **public site** (households/retailers) and an **admin dashboard** (staff) from a
**single Flask app**. It also models the **dynamic import tariff** on imported rice and shows a
**consumer price** = base price + applicable taxes.

**One honest headline for the panel (training run 2026‑09‑26):** the published forecast — an
**LSTM‑based adaptive ensemble** (LSTM hybrid + ARIMA(1,1,1) + weekday Kalman filter) — beats naive
persistence on **8/8** rice types (**skill +10.06%**, worst +2.63%) and **ARIMA(1,1,1) on 8/8**, with
price ranges that cover **91.5%** of actual prices (target 90%). Say precisely where the gain comes
from: the **LSTM network alone does not add significant accuracy** (McNemar p = 0.95; alone it
reproduces persistence, skill −1.29%) — the gain is the weekday mean‑reversion term and the forecast
combination. Rice prices are a **near‑random walk** (ADF p 0.08–0.21), so the margin is small in pesos
(≈ ₱0.03/kg) but consistent.

---

## 1. Architecture at a glance

```
 Data sources                Ingestion                Storage            Model                 Serving
 ────────────                ─────────                ───────            ─────                 ───────
 DA price bulletins (PDF)    tools/scrap.py           SQLite            model/train.py         api/app.py (Flask :5000)
 Manila fuel prices (web)    datasets/import_2026.py  agriprice_        (MinMaxScaler +        ├─ REST /api/*
 USD/PHP (keyless API)       tools/pdfconvrt.py        database.db       30‑day LSTM per type)  ├─ SSE log streams
 2015–2026 XLSX/CSV                                    (WS_* + history   → model/lstm_models/    ├─ static file server
                                                        tables)          *.keras + meta.json   └─ serves public/ + admin/
```

- **One Flask process** (`api/app.py`, ~2,400 lines) does three jobs: REST API under `/api/*`,
  **static file server** (serves `public/` and `admin/` so everything runs same‑origin on
  `:5000`), and **CLI modes** (`--serve`, `--once`, `--loop`).
- **Frontend is plain HTML/CSS/JS** — no framework, no bundler. Three layers:
  `js/` (shared: `api.js`, `data.js`), `public/js/` (user site), `admin/js/` (SPA dashboard).
- Long jobs (scrape, train) run in **background threads**; the browser **polls** status endpoints
  or subscribes to **SSE** streams (`/api/stream-scrape`, `/api/stream-training`).

---

## 2. Data layer

### 2.1 Sources (what feeds the model)
| Signal | Source | Notes |
|---|---|---|
| Retail rice prices (8 types) | DA price bulletins (PDF) | extracted with **rule‑based, layout‑aware PDF parsing** (`tools/pdfconvrt.py`), **not** HTML scraping |
| Fuel (RON95, diesel) | public Manila fuel‑price page | proxy for pump prices |
| USD→PHP exchange rate | keyless public API (open.er‑api.com) | **no hardcoded API key** |
| Rice stock, farmgate | historical XLSX/CSV | 2015–2026 |

### 2.2 Ingestion
- `tools/scrap.py` — live fetchers (`fetch_rice_prices`, `fetch_fuel_prices`,
  `fetch_exchange_rates`) write to `WS_*` tables + CSV backups under `tools/scrapped */`.
  Runs **every 24h** from the app and can be triggered manually (`/api/run-scraper`).
- `datasets/import_2026.py` — syncs the current‑year daily files; **auto‑runs on every app
  startup** so the DB stays current with no manual step.
- `datasets/script.py` — one‑time bulk import of the 2015–2025 history.

### 2.3 Database (SQLite, `datasets/agriprice_database.db`)
- **Time‑series tables** used by the model: `retail_prices` + `WS_rice_price`, `fuel_history` +
  `WS_fuel`, `usd_php_rates` + `WS_currency`, `rice_stock`, `weather_data`.
- **Catalog/tax layer** (added for Round‑2 DTI feedback, `datasets/catalog_schema.py`):
  `dti_category` (8 rice types), `rice_brand`, `market`, `rice_price_bracket` (min–max ranges),
  `tax_component` (VAT), and the **tariff tables** (`tariff_schedule`, `tariff_audit`,
  `tariff_config`).

**Panel Q — "Is your data real?"** Yes; every catalog/tax row is backed by a cited source
(`source`/`legal_basis` columns). We use **empty states** rather than invent brands/prices.

---

## 3. The forecasting model (core contribution)

### 3.1 Inputs & features (`model/data_pipeline.py`)
- **Target:** retail price per rice type. **8 separate models**, one per type:
  `locWellMilled, locRegular, locPremium, locSpecial, impWellMilled, impRegular, impPremium, impSpecial`.
- **Raw feature columns:** `fuel_ron95, fuel_diesel, stock, farmgate, exchange`.
- **Engineered features** (`add_engineered_features`): seasonal `sin/cos` of month; 7‑day rolling
  averages of diesel & exchange; and the target's own **lag‑1, lag‑7, and 7‑day rolling** values.
  → about **13 features** feed the network.
- **Look‑back window `SEQ_LEN = 30`** days; **forecast `HORIZON = 3`** days (48–72h).

### 3.2 Anchored‑delta forecasting (important design choice)
`DELTA_MODE` is **on by default**. The network predicts the **change from the last observed
price** (a delta), and inference reconstructs the level: `pred = last_price + predicted_delta`.
This **anchors** forecasts to reality and prevents level drift. It also means the model
**gracefully degrades toward persistence** — the correct floor for a near‑random‑walk series.

> Defense note: a past regression once retrained the *worse* "level mode" (MAE ≈ ₱1.08) because a
> spawned training process didn't inherit the env flag. We fixed the default to delta‑mode
> (MAE ≈ ₱0.24). This is why `AGRIPRICE_DELTA_MODE` defaults to `1` in `train.py`.

### 3.3 Training (`model/train.py`)
- **Regime‑aware chronological split** (`train.py::_split_indices`): train 2015‑01‑31 → 2025‑03‑31,
  validation 2025‑04‑01 → 2025‑10‑06, test 2025‑10‑07 → 2026‑09‑24 (353 origins per type). Validation
  and test both come from the **daily‑observation era** (DA data before 2025 is weekly, carried
  forward). The old 70/15/15 put an 88%‑flat period in validation. **No shuffling.**
- **Scaler fit on training rows only** (`MinMaxScaler` on `raw[:train_row_end]`) — another
  leakage guard.
- LSTM with dropout + early stopping; **falls back to a scikit‑learn `MLPRegressor`** if
  TensorFlow is unavailable (`meta.json.backend` records which ran; current = `tensorflow`).
- Writes per‑type `*.keras`, the scaler, and `meta.json` (v4) with full metrics, including the
  hybrid's own numbers and the ensemble's weights per type.

### 3.4 Evaluation & honest results (`meta.json`)
Test window 2025‑10‑07 → 2026‑09‑24, MAE pooled over days 1–3 (₱/kg):
| Rice type | Ensemble | Persistence | ARIMA(1,1,1) | Skill | Day‑1 direction |
|---|---|---|---|---|---|
| Local Well‑Milled | **0.280** | 0.325 | 0.284 | +13.9% | 61.5% |
| Local Regular | **0.264** | 0.314 | 0.277 | +15.7% | 62.3% |
| Local Premium | **0.263** | 0.294 | 0.271 | +10.3% | 59.4% |
| Local Special | **0.215** | 0.255 | 0.225 | +15.6% | 57.9% |
| Imported Well‑Milled | **0.283** | 0.292 | 0.297 | +3.2% | 65.6% |
| Imported Regular | **0.329** | 0.346 | 0.353 | +5.0% | 45.7% (chance) |
| Imported Premium | **0.309** | 0.318 | 0.351 | +2.6% | 50.3% (chance) |
| Imported Special | **0.339** | 0.396 | 0.343 | +14.2% | 68.9% |

Component ladder (same window): LSTM alone −1.29% → LSTM hybrid (+ weekday reversion) +7.80%
(ARIMA 4/8) → adaptive ensemble +10.06% (ARIMA 8/8). Hit rate within ₱1.00: 96.1 / 95.4 / 94.8%
(days 1/2/3). Range coverage 91.5%.

- **Baselines:** naive **persistence** ("tomorrow = today") and **ARIMA(1,1,1)** walk‑forward.
- **ADF test** p 0.08–0.21 ⇒ series is **near random walk** → persistence is a very strong benchmark.
- **Caveats to state first:** the LSTM ablation is not significant (149 vs 151, p = 0.95); direction
  is at chance for impRegular/impPremium; the test window was reused across experiments, so a
  **forward evaluation** runs from 2026‑09‑26 (`model/forecast_log.py`, `GET /api/forecast-check`).
- **R² is not used as proof of quality** — because prices trend, persistence also scores high R².
  The honest metric is **MAE/RMSE vs the baselines**.
- Also computed: **rolling‑origin** (blocked, k=5) for stability and **shock‑day** metrics
  (top‑10% most volatile days).

**Why 8 models, not one multi‑output?** Each rice type gets its own scaler and dynamics, which
improved per‑type error and lets each retrain independently. Trade‑off: 8 artifacts to store —
acceptable.

### 3.5 Inference (`model/predict.py`)
Loads the fitted scaler + per‑type model, builds the **last 30‑day window**, predicts the 3‑day
delta, adds the weekday mean‑reversion term (the **LSTM hybrid**), then combines it with ARIMA(1,1,1)
and a weekday Kalman filter, each weighted by 1/MSE over its last 30 realised forecasts (the
**adaptive ensemble**, `model/ensemble.py`). Every day gets a conformal **price range** (~90%
realised) and a **direction** (`steady` when the move is under ₱0.10). Day *h* is dated **last DA
price day + h**. Served at **`/api/predictions`** (cached until new data or a retrain; rebuilt after
each successful rice scrape) and logged once to `forecast_log` for forward evaluation.

---

## 4. Public site features (`public/`)

Shared shell (`public/js/public-shell.js`) injects one navbar. Accounts are **server‑side**
(`model/user_store.py`, SQLite `model/agriprice_users.db`; werkzeug‑hashed passwords; email password
reset). Older browser‑`localStorage` demo accounts migrate automatically on their next login.

### 4.1 Roles (simplified)
A single **Retailer** account role. Households use the site as **free guests** (today's prices +
3‑day forecast need no account). Legacy `vendor`/`household` accounts are **normalized to
`retailer` at login** so nothing breaks. (The paper's "local vendors" = the app's "Retailer".)

### 4.2 Landing page (`landpage.html` + `landpage.js`)
Hero ticker, live price cards, and CTAs. **For logged‑in users the "Create free account" / "Log in"
CTAs are removed** (conditional render on `isLoggedIn()`, not CSS); the "See today's prices" CTAs
remain.

### 4.3 Price Forecast (`current-prices.html`)
Today's price + the **3‑day forecast** per rice type, drawn from `/api/predictions` with its
calibrated price range; moves under ₱0.10 are shown as "about the same". Free for guests.

### 4.4 Rice Catalog (`rice-catalog.html`) — NCR only
**8 category tabs** drive **one reusable table**: Brand | Price | Actual Package | Location | Source
| Last Update. **Price comes from the forecast/bracket data**, never stored per brand. Only
**verified, cited** products appear (e.g., Doña Maria Jasponica/Miponica 5kg; Royal Umbrella Thai
Hom Mali 5kg); other categories show an **empty state** — consistent with DA's 2018 rule that
milled rice is sold **by classification, not brand**.

### 4.5 Price History & Charts (`historical.html`, `statistics.html`)
Historical series and interactive charts. These are **gated**: guests get an unlock prompt;
logged‑in users see the content. **Charts & Stats** (`public/js/public-stats.js`) is four tabs, one
screen each: what moved this week, local vs imported by grade, the price trend for one rice, and a
monthly rice budget — all live from the database, with one‑day survey spikes filtered out.

### 4.6 Profile (`profile.html`) & Settings (`settings.html`) — logged‑in only
Both shown **only to logged‑in users** (guest nav hides them; visiting either URL directly
redirects to the landpage — enforced in auth logic, not CSS), reached from the topbar's Profile
(avatar) and Settings (gear) icons. **Profile** is the account module — styled to match the admin
Account Profile page (cover banner, avatar, card grid): edit name/email, **change password**, and
**Log out**, all persisted server‑side via `/api/auth/*`. **Settings** holds everything else —
**Appearance** (theme/compact/reduce‑motion), **Preferences** (default page after login → wired
into the post‑login redirect; date format → wired into `dates.js`), and **Privacy & data** (export
my data as JSON, reset preferences, clear saved logins) — all client‑side/`localStorage`. Signup
enforces a **strong password** (≥8 with upper/lower/number) with a confirm field, show/hide toggle,
live strength meter, and a terms checkbox.

---

## 5. Admin dashboard features (`admin/`)

A lightweight **SPA**: `admin/js/router.js` loads HTML fragments from `admin/pages/*.html` into
`admin/index.html`; one JS module per page. Admin auth (`model/admin_auth.py`) issues a
**server‑side session token**, hashes the 6‑digit code, and **locks out after 5 failed attempts
for 15 minutes**. Default demo login: `admin` / `Admin@123` / `123456`.

| Page | What it does |
|---|---|
| **Dashboard** | KPI overview + summary cards |
| **Live Predictions** | current `/api/predictions` per type |
| **Data Sources** | source status/config |
| **Historical Data** | browse stored series |
| **Web Scraper** | **Run Now** (`/api/run-scraper`), live activity log (SSE/poll), stat cards, schedule/countdown, and **Held for review** — readings the scraper guard would not save (duplicate of an adjacent grade, or > 6% from the 7‑reading median), with Approve/Reject. |
| **LSTM Model / Training** | start training (spawns `train.py`), SSE log stream (`/api/stream-training`) |
| **Model Dashboard (Metrics)** | published forecast vs persistence vs ARIMA per type, MAPE/R²/rolling/shock — with the **honest R² caveat** |
| **Correlation Analysis** | driver correlations incl. the **import‑tariff factor** (raw Pearson r ≈ −0.03, a policy step‑variable) |
| **Taxes & Import Charges** | tariff schedule + consumer‑price preview (see §6) |
| **Price Alerts** | threshold rules (`alerts_engine.py`), fired events logged |
| **Reports** | generate/export report files |
| **System Logs** | real system activity (see §7) |
| **Settings** | server‑backed settings (`/api/settings`), password change |

---

## 6. Dynamic import‑tariff system (a standout feature)

**Why it exists:** imported rice carries an MFN import tariff that raises the consumer price, and
the tariff is **not fixed**.

### 6.1 The real‑world rule (verified from official sources)
- **EO 62 s.2024** cut the rice tariff from **35% → 15%**.
- **EO 105 s.2025 + IAGRTA Circular No. 2025‑001** (effective **Jan 1, 2026**) made it a
  **quarterly, price‑indexed** rate within a **15%–35% band**, indexed to the **Vietnam 5%‑broken
  FOB price (UN‑FAO)** vs a **March‑2025 baseline**, moving **±5 percentage points per 5%** price
  move. **Q1 2026 = 15%** (trigger not breached).
- Each quarter the **DA posts a certification** (da.gov.ph) and **BOC issues a Customs Memorandum
  Order**. **There is no official API/feed** — so we do **not** fake an auto‑updater.

### 6.2 How the app models it (`datasets/catalog_schema.py`, `api/catalog_service.py`)
- **`tariff_schedule`** — one **dated row per confirmed quarter**: `rate_pct`, `effective_start`,
  `effective_end`, `quarter_label`, `legal_basis`, `da_certification_url`, `verified`,
  `approved_by/at`, **`active`**.
- **Date‑aware selection** — `_applicable_tariff(date)` picks the row whose
  `[effective_start, effective_end]` **covers the date** *and* is `active=1`.
- **Staleness (honest)** — if today falls in a quarter with **no confirmed row**, it returns the
  **last confirmed rate flagged "unconfirmed for current quarter — pending DA certification."** It
  **never** silently rolls a past rate forward or invents a number.
- **Consumer price** = base price (bracket midpoint or latest scraped) **+ applicable tariff**
  (imported only) **+ VAT**. **VAT = 0%** — rice is VAT‑exempt (NIRC §109); we deliberately do
  **not** add 12%.
- **Admin workflow** — the Taxes page shows the current rate + **staleness banner**, the full
  schedule, an **add‑quarter form** (rate + effective dates + certification URL), and a **FAO
  indicative helper** (a decision aid only; the DA certification is authoritative — baseline left
  unset rather than guessed).

### 6.3 Activate / Deactivate (latest feature)
- An admin can **Deactivate** a tariff row to keep it for **history/audit** without letting it
  affect calculations, and **Activate** it again later.
- Endpoint: **`POST /api/tariff/<id>/status`** (admin‑guarded) → `set_tariff_active()` flips the
  **`active`** flag, writes a **`tariff_audit`** row, and emits a **`TARIFF` System‑Logs** entry.
- **Backend enforcement:** because `_applicable_tariff()` only considers `active=1`, an inactive
  tariff is **never applied** in the consumer‑price calculation — but it stays **visible** in the
  admin schedule (dimmed + **INACTIVE** badge) with its source/legal basis intact.
- UI: a **Status** badge (ACTIVE/INACTIVE) and a **Deactivate/Activate** button with a
  **confirmation dialog** (financial safety).

**Panel Q — "Prove an inactive tariff can't affect prices."** Deactivate Q1‑2026 → `/api/tariff`
`applicable` becomes null (or falls back/stale) and `/api/consumer-price` for an imported type
drops to VAT‑only. Reactivate → the 15% returns. Every toggle is in System Logs + `tariff_audit`.

---

## 7. System Logs (`admin` → System Logs)

- The backend keeps an **in‑memory ring buffer** `_LOG_BUFFER` (`api/app.py`) filled by a logging
  handler + `_add_log(level, msg, source)`. Entries: `{time, level, source, msg}`.
- Exposed via admin‑guarded **`GET /api/logs`** (newest‑first, `?level=`/`?limit=` filters) and
  **`POST /api/logs/clear`**. The page renders real entries with **loading/empty/error** states,
  level + text filters, **Export** (JSON) and **Clear**.
- Records real events: **scrape lifecycle, alerts, model warm‑up, and admin auth** (sign‑in
  success/failure/lockout, with client **IP + timestamp**). Raw Werkzeug HTTP access noise is
  filtered out.
- **In‑memory only** ⇒ logs reset on server restart (stated honestly; the privacy disclosure in
  the paper notes admin IP logging under RA 10173).

> History: this page used to render a **static mock array**; the fix wires it to the real buffer.

---

## 8. Security & authentication (know these)
- **Admin:** server‑issued session **token** (not a client flag), 6‑digit code **hashed**
  server‑side, **5‑attempt / 15‑minute lockout**. **All state‑changing admin endpoints enforce
  `_require_admin()`** (scraper/training control, settings PUT/reset/password, alerts CRUD, reports
  generate/delete, import, tariff writes, logs) → a call without a valid admin token returns **401**.
  The shared `js/api.js` auto‑attaches the admin token so the dashboard authenticates every call;
  public read endpoints stay open. Frontend hiding is **not** the security boundary — the backend is.
- **Public:** server‑side accounts (`model/user_auth.py`, hashed passwords, email reset).
- **Exchange API** is keyless (no secret in the repo).
- **Known pre‑deployment hardening** (be honest): rotate the default admin credentials, run behind
  a production WSGI server (Waitress/Gunicorn) instead of the Flask dev server, add HTTPS + tighter
  CORS, and set restrictive SQLite file permissions.

---

## 9. What the latest feedback rounds changed (and why)
1. **Signup simplified** to a single **Retailer** role (Household removed); households remain free
   guests. *Why:* one meaningful account type; less confusion; DTI‑aligned term.
2. **Settings** trimmed to Account + Appearance and made **logged‑in only** + URL‑guarded. *Why:*
   the removed options were client‑only clutter; settings shouldn't show to guests.
3. **System Logs** turned from **mock → real** backend buffer. *Why:* an admin page must reflect
   actual activity.
4. **Web Scraper** preview table removed (display‑only). *Why:* redundant with stored data.
5. **Dynamic tariff** (effective‑date table + staleness + admin approval + audit + FAO helper).
   *Why:* the tariff is quarterly/price‑indexed, not a fixed 15%.
6. **Nav logout removed**, logout consolidated in **Settings → Account**; landing‑page
   **"Create free account" hidden for logged‑in users**. *Why:* remove duplicate/irrelevant CTAs.
7. **Tariff activate/deactivate** for auditable, non‑destructive retirement of tariff records.
8. **Paper synced** — tariff wording + IP‑logging disclosure updated in the `.docx`
   (see `PAPER_CORRECTIONS.md`).
9. **Round‑3:** post‑login routes to **Price Forecast**; **Settings** removed from the primary nav
   on every page and moved to a **burger menu**, with a circular **Profile** icon → Settings →
   Account; tariff **"Admin Entry"** label (server‑set `entry_type`) + a **release‑confirmation**
   popup; emoji controls replaced with SVGs. **PSA/PAGASA researched → not automated:** no official
   PAGASA rainfall API (CliMap downloads only; rainfall isn't a model feature); PSA stock is on
   OpenSTAT but **monthly/aggregated**, so it's a **manual import** (both shown as *Planned* in the
   Web Scraper). Reliability over forced automation.

---

## 10. Five defense talking points (say these confidently)
1. **Measured, not assumed:** the published ensemble beats persistence and ARIMA on 8/8 types; the
   LSTM network alone does not add significant accuracy (p = 0.95), and we say so — the gain is the
   mean‑reversion structure and forecast combination. A forward evaluation confirms it on new data.
2. **No leakage:** regime‑aware chronological split, scaler fit on train only, ensemble weights and
   reversion coefficients from past data only, seeded runs.
3. **No fabrication:** verified sources only; empty states over invented data; the FAO baseline is
   left unset rather than guessed; tariff staleness is surfaced, not hidden.
4. **Decision‑support, not a guarantee:** forecasts come with an error band; the tariff/consumer
   price is traceable to EOs/circulars and an admin‑approved effective‑date table.
5. **Deployability is a config step:** dev server + demo credentials are for the study; production
   hardening is a documented checklist, not a rewrite.

---

*Keep this file in sync with the code. If you change a feature, update the relevant section here
and log it in `PAPER_CORRECTIONS.md`.*

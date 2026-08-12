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

**One honest headline for the panel:** at this short horizon NCR rice prices behave like a
**near‑random walk** (ADF p ≈ 0.07), so the LSTM **matches** — does not beat — the naive
persistence and ARIMA baselines. The contribution is a **working, unified, multivariate
decision‑support system with honest evaluation**, not a lower error number.

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
- **Chronological 70/15/15 split** (`i_tr = 0.70·n`, `i_va = 0.85·n`) — earliest 70% train,
  next 15% validation, most recent 15% test. **No shuffling** (prevents look‑ahead leakage).
- **Scaler fit on training rows only** (`MinMaxScaler` on `raw[:train_row_end]`) — another
  leakage guard.
- LSTM with dropout + early stopping; **falls back to a scikit‑learn `MLPRegressor`** if
  TensorFlow is unavailable (`meta.json.backend` records which ran; current = `tensorflow`).
- Writes per‑type `*.keras`, the scaler, and `meta.json` (v3) with full metrics.

### 3.4 Evaluation & honest results (`meta.json`)
For `locWellMilled` (representative):
| Metric | LSTM | Persistence baseline | ARIMA(1,1,1) |
|---|---|---|---|
| MAE (₱/kg) | **0.243** | 0.228 | 0.228 |
| MAPE | **0.54%** | — | — |
| R² | 0.987 | (similarly high) | — |
| ADF p‑value | 0.070 (non‑stationary) | | |

- **Baselines:** naive **persistence** ("tomorrow = today") and **ARIMA(1,1,1)** walk‑forward.
- **ADF test** p ≈ 0.07 ⇒ series is **non‑stationary / near random walk** → persistence is a very
  strong benchmark; matching it is the expected, honest outcome.
- **R² is not used as proof of quality** — because prices trend, persistence also scores high R².
  The honest metric is **MAE/RMSE vs the baselines**.
- Also computed: **rolling‑origin** (blocked, k=5) for stability and **shock‑day** metrics
  (top‑10% most volatile days).

**Why 8 models, not one multi‑output?** Each rice type gets its own scaler and dynamics, which
improved per‑type error and lets each retrain independently. Trade‑off: 8 artifacts to store —
acceptable.

### 3.5 Inference (`model/predict.py`)
Loads the fitted scaler + per‑type model, builds the **last 30‑day window**, predicts the 3‑day
delta, reconstructs the level, and serves it at **`/api/predictions`** (cached/warmed in a
background thread at startup). `model_notes.method` reports the model that actually produced it.

---

## 4. Public site features (`public/`)

Shared shell (`public/js/public-shell.js`) injects one navbar. Auth state
(`public/js/public-auth.js`) is **browser‑local** (demo): users live in `localStorage`
(`agriprice_public_users`), session in `sessionStorage`. There is **no server user database** —
state that plainly; it's a design choice for the demo.

### 4.1 Roles (simplified)
A single **Retailer** account role. Households use the site as **free guests** (today's prices +
3‑day forecast need no account). Legacy `vendor`/`household` accounts are **normalized to
`retailer` at login** so nothing breaks. (The paper's "local vendors" = the app's "Retailer".)

### 4.2 Landing page (`landpage.html` + `landpage.js`)
Hero ticker, live price cards, and CTAs. **For logged‑in users the "Create free account" / "Log in"
CTAs are removed** (conditional render on `isLoggedIn()`, not CSS); the "See today's prices" CTAs
remain.

### 4.3 Price Forecast (`current-prices.html`)
Today's price + the **3‑day forecast** per rice type, drawn from `/api/predictions` with an error
band (±MAE). Free for guests.

### 4.4 Rice Catalog (`rice-catalog.html`) — NCR only
**8 category tabs** drive **one reusable table**: Brand | Price | Actual Package | Location | Source
| Last Update. **Price comes from the forecast/bracket data**, never stored per brand. Only
**verified, cited** products appear (e.g., Doña Maria Jasponica/Miponica 5kg; Royal Umbrella Thai
Hom Mali 5kg); other categories show an **empty state** — consistent with DA's 2018 rule that
milled rice is sold **by classification, not brand**.

### 4.5 Price History & Charts (`historical.html`, `statistics.html`)
Historical series and interactive charts. These are **gated**: guests get an unlock prompt;
logged‑in users see the content. The stats view has a vendor/household **data lens** (framing of
the copy), separate from the account role.

### 4.6 Settings (`settings.html`) — logged‑in only
Shown **only to logged‑in users** (guest nav hides it; visiting the URL directly redirects to the
landpage — enforced in auth logic, not CSS). Contains **Account** (with the single **Log out**
action) and **Appearance** (theme/compact/reduce‑motion, stored in `localStorage`).

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
| **Web Scraper** | **Run Now** (`/api/run-scraper`), live activity log (SSE/poll), stat cards, schedule/countdown. (The old "Live Scraped Data Preview" table was removed as redundant; scraping/storage unchanged.) |
| **LSTM Model / Training** | start training (spawns `train.py`), SSE log stream (`/api/stream-training`) |
| **Performance Metrics** | LSTM vs persistence vs ARIMA, MAPE/R²/rolling/shock — with the **honest R² caveat** |
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
  server‑side, **5‑attempt / 15‑minute lockout**; admin write endpoints call `_require_admin()`.
- **Public:** demo accounts in `localStorage` (passwords in plaintext **in the browser** — a
  demo limitation, disclosed). No server user DB.
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

---

## 10. Five defense talking points (say these confidently)
1. **Honest evaluation:** LSTM ≈ persistence ≈ ARIMA at 1–3 days because ADF says near‑random walk.
   Demonstrating that deep learning does **not** beat a baseline is a **valid empirical finding**.
2. **No leakage:** chronological 70/15/15, scaler fit on train only, anchored‑delta reconstruction.
3. **No fabrication:** verified sources only; empty states over invented data; the FAO baseline is
   left unset rather than guessed; tariff staleness is surfaced, not hidden.
4. **Decision‑support, not a guarantee:** forecasts come with an error band; the tariff/consumer
   price is traceable to EOs/circulars and an admin‑approved effective‑date table.
5. **Deployability is a config step:** dev server + demo credentials are for the study; production
   hardening is a documented checklist, not a rewrite.

---

*Keep this file in sync with the code. If you change a feature, update the relevant section here
and log it in `PAPER_CORRECTIONS.md`.*

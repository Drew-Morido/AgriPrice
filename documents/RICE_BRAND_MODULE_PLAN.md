# Rice Brand Module — 3-Phase Build Plan

**Built as ONE new admin module — "Rice Brands"** (`admin/pages/rice-brands.html` +
`admin/js/rice-brands.js`, registered in `admin/js/router.js` like every other admin page). Each
phase adds to this same page — you are never juggling several half-finished features, just one
module that gets more capable each phase.

**Non-negotiable rule for all 3 phases:** nothing in `model/` (`train.py`, `predict.py`,
`meta.json`, `scaler.joblib`) is touched. The LSTM keeps forecasting exactly the 8 categories it
does today. Brand is a layer on top, never an input to the model.

Data source for seeding: `datasets/Rice_Brand_Final_Mapping.xlsx` (34 curated brands + Akira +
Master Chef Well-Milled = 36 rows, "Final Brand Mapping" sheet).

---

## Phase 1 — Brand Catalog Module (Foundation)

**Goal:** Get the module to *exist* and show real data. Read-only. No pricing math yet — every
brand still shows the plain category price. This proves the plumbing works end-to-end before any
new logic is added.

**What gets built**
1. `datasets/seed_brand_mapping.py` — reads `Rice_Brand_Final_Mapping.xlsx`'s "Final Brand
   Mapping" sheet and inserts each row into `rice_brand` (via the existing
   `datasets/catalog_schema.py` tables — creates them if missing, seeds the 8 categories, then
   inserts brands). Idempotent: running it twice must not create duplicates.
2. `admin/pages/rice-brands.html` + `admin/js/rice-brands.js` — new admin page, read-only table
   of all brands grouped by the 8 categories. Pulls from the **existing** `GET /api/catalog`
   endpoint — no backend changes needed this phase.
3. Register the page in `admin/js/router.js` and add a "Rice Brands" link to the admin sidebar.

**Files touched:** `datasets/seed_brand_mapping.py` (new), `admin/pages/rice-brands.html` (new),
`admin/js/rice-brands.js` (new), `admin/js/router.js` (add one route), admin nav/sidebar file
(add one link).

**Done when:** log into Admin → Rice Brands shows all 32 brands, correctly grouped, and the
counts match the "Coverage Summary" sheet in the xlsx (Local Well-Milled still empty — expected).

**Phase 1 prompt (paste this to start):**
> Implement Phase 1 of the Rice Brand module. (1) Write `datasets/seed_brand_mapping.py` that
> reads the "Final Brand Mapping" sheet of `datasets/Rice_Brand_Final_Mapping.xlsx` and inserts
> each row into the `rice_brand` table using the schema in `datasets/catalog_schema.py` (create
> tables + seed the 8 categories if not already done, then insert brands — make it idempotent,
> skip rows that already exist). (2) Add a new **read-only** admin page "Rice Brands"
> (`admin/pages/rice-brands.html` + `admin/js/rice-brands.js`) listing all brands grouped by the
> 8 categories, sourced from the existing `GET /api/catalog` endpoint — no backend/API changes
> this phase. (3) Register the page in `admin/js/router.js` and add a nav link in the admin
> sidebar. Do not touch anything in `model/`. When done, run the seed script and show me the
> brand counts per category so I can check them against the Coverage Summary sheet.

---

## Phase 2 — Variance Weight Engine ("Patong")

**Goal:** Each brand can now show its **own adjusted price** — base forecast × (1 + weight%) —
instead of the flat category price. This is the "Stage 4" idea, made real.

**What gets built**
1. Two new tables (added to `datasets/catalog_schema.py`): `brand_price_adjustment` (brand_id,
   weight_pct, sample_date, sample_locations, sample_n, source_notes, entry_type, updated_by,
   updated_at) and `brand_weight_audit` (logs every change — mirrors the existing
   `tariff_audit` pattern).
2. In `api/catalog_service.py`: `brand_price(canonical_key)` — returns each mapped brand's price
   as `base_price × (1 + weight_pct/100)`, falling back to the plain base price for any brand
   with no weight yet. `set_brand_weight()` — validates the % is within a sane band (e.g. ±20%),
   saves it, writes an audit row.
3. New endpoint(s) in `api/app.py`: `GET /api/brand-prices` (public-safe read) and an
   admin-only write route for setting a weight — reuse the existing admin session auth.
4. On the Rice Brands admin page (from Phase 1): add a "Weight %" column with an inline edit
   field wired to the new write endpoint.
5. On the public Rice Catalog page (`public/js/public-catalog.js`): show the adjusted price per
   brand instead of the flat category price, labeled **"Estimated — base forecast + observed
   retail premium, surveyed [date]"** — never "AI predicted."
6. Only enter a weight % for brands you actually canvassed. Everything else stays unadjusted —
   that's an honest, correct state, not a gap to hide.

**Files touched:** `datasets/catalog_schema.py` (2 new tables), `api/catalog_service.py` (2 new
functions), `api/app.py` (routes), `admin/js/rice-brands.js` (weight column + edit), `admin/js/`
or `public/js/public-catalog.js` (adjusted price display).

**Done when:** editing Dinorado's weight in Admin → Rice Brands changes what shows on the public
Rice Catalog page for Dinorado specifically (not the whole category), and the audit table has a
row recording who changed it and when.

**Phase 2 prompt (paste this to start):**
> Implement Phase 2 of the Rice Brand module — the variance weight ("patong") layer. Add
> `brand_price_adjustment` and `brand_weight_audit` tables to `datasets/catalog_schema.py`. In
> `api/catalog_service.py` add `brand_price(canonical_key)` returning each brand's price as
> `base_price × (1 + weight_pct/100)`, falling back to the plain base price when a brand has no
> weight row yet; add `set_brand_weight()` validating the % is within ±20% and writing an audit
> row. Expose a `GET /api/brand-prices` endpoint and an admin-only write endpoint in
> `api/app.py`, reusing existing admin session auth. On the Rice Brands admin page (built in
> Phase 1), add a "Weight %" column with inline editing wired to the new endpoint. On
> `public/js/public-catalog.js`, show each brand's adjusted price instead of the flat category
> price, labeled "Estimated — base forecast + observed retail premium, surveyed [date]." Do not
> invent weights for brands with no field data — leave those unadjusted.

---

## Phase 3 — Full Admin Management (CRUD + Verification Tiers)

**Goal:** Turn the module from "data we seeded once" into a feature you can actually maintain —
add/edit/deactivate brands from the UI, and give field-collected data an honest "verified" status
(instead of every row saying a flat "NO").

**What gets built**
1. In `api/catalog_service.py`: `add_brand()`, `update_brand()`, `deactivate_brand()`
   (soft-delete via an `active` flag — never hard-delete, keeps history). Each writes to a new
   `brand_audit` table (mirrors `tariff_audit`: action, brand_id, actor, detail, timestamp).
2. Replace the single `is_verified` 0/1 flag with a `verification_status` field:
   `unverified` / `field_verified` / `dti_verified`, plus `verified_by` and `verified_at`.
   Migrate all current rows to `field_verified` — that's the true status of your existing data.
3. New admin routes in `app.py`: `POST` (add), `PUT` (edit), `DELETE`/`PATCH` (deactivate) —
   admin-auth protected, same pattern as the tariff admin routes.
4. Rice Brands admin page gets a real form: add a new brand, edit an existing one (name,
   category, package, location, source, source URL, verification status), deactivate a brand,
   and view its change history.
5. Guardrails: block saving a duplicate (category + brand name + package); require a source note
   before saving a new brand — no silent/blank entries.

**Files touched:** `api/catalog_service.py` (3 new functions + 1 new table), `api/app.py` (3 new
routes), `admin/js/rice-brands.js` (add/edit/deactivate form + history view).

**Done when:** you can add a brand for **Local Well-Milled** (your one remaining empty category)
straight from the admin UI, mark it Field-Verified, watch it appear on the public Rice Catalog
immediately, and see the change logged in the audit history.

**Phase 3 prompt (paste this to start):**
> Implement Phase 3 of the Rice Brand module — full CRUD + governance. In
> `api/catalog_service.py` add `add_brand()`, `update_brand()`, and `deactivate_brand()`
> (soft-delete via an `active` flag), each validating required fields (brand name, category,
> source) and writing to a new `brand_audit` table (mirroring `tariff_audit`: action, brand_id,
> actor, detail, created_at). Replace the single `is_verified` flag with a `verification_status`
> field (`unverified` / `field_verified` / `dti_verified`) plus `verified_by`/`verified_at`,
> migrating all existing brand rows to `field_verified`. Add admin-auth-protected POST/PUT/DELETE
> routes in `api/app.py`. Extend the Rice Brands admin page (from Phases 1–2) with a form to add
> a new brand, edit an existing one, change its verification status, and deactivate it, plus a
> small per-brand change-history view. Block saving a duplicate (category, brand name, package)
> and require a source note before saving.

---

## Quick reference

| Phase | Adds | Risk to core LSTM |
|---|---|---|
| 1 | The module exists, shows seeded brands (read-only) | None |
| 2 | Per-brand adjusted price (patong) | None |
| 3 | Add/edit/deactivate brands from the UI + audit trail | None |

Do them in order — each phase is a working, demoable state on its own, so you're never stuck
mid-feature if you need to pause between sessions.

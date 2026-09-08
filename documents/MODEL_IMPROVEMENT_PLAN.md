# Model Improvement Plan — Getting Past "Ties the Baseline"

**Starting score: 3/5.** Root problem (confirmed against the live DB, not guessed): the LSTM
never beats naive persistence or ARIMA(1,1,1) on any of the 8 categories, and doesn't beat
persistence even on the "shock" (big-move) subset. Root *cause*, newly found:

> Across `datasets/agriprice_database.db`'s `retail_prices` table, **~90% of daily rows are
> exact duplicates of the previous day** (longest flat streak: 591 days, Imported Special).
> `model/data_pipeline.py` forward/back-fills gaps (`ffill().bfill()`), so a baseline that
> predicts "tomorrow = today" is trivially correct on ~90% of rows by construction — that's
> not the same thing as rice prices being genuinely unpredictable.

This plan does not guarantee the model ends up beating baseline — short-horizon commodity
price forecasting is genuinely hard, and no plan can promise otherwise. What it does guarantee:
a real, evidence-based attempt, and a defensible, much stronger finding either way.

**Rule for all 5 phases:** every claim that goes in `meta.json`/the paper must be something the
numbers actually show — this plan does not replace the "we found X, honestly reported" ethos
that's already working in your favor; it tries to make X a better finding.

---

## Phase 1 — Confirm & Document the Root Cause

**Goal:** Prove (not assume) where the flat-lining comes from, so Phase 2 fixes the right thing.

**What to do**
1. Check `datasets/script.py` (the 2015–2025 historical importer) — does the source file it
   reads already contain daily values, or is it a weekly/monthly published series that got
   expanded into a daily schema at import time?
2. Check `tools/scrap.py`'s live scraper — does DA actually publish a new bulletin every day,
   or every few days/weekly, with the scraper just recording "last known" on off days?
3. Quantify the *real* update cadence per category (median days between actual value changes,
   not calendar days).
4. Write up the finding in one page: this is citable in your paper regardless of what happens
   next — "X% of nominal daily observations are carried-forward duplicates; the true DA
   publication cadence is approximately every N days" is a genuine, defensible research finding.

**Phase 1 prompt:**
> Investigate the root cause of the ~90% zero-change-day / up-to-591-day flat streaks found in
> `datasets/agriprice_database.db`'s `retail_prices` table. Check whether `datasets/script.py`'s
> historical import already receives non-daily source data, and whether `tools/scrap.py`'s live
> scraper only gets a new DA bulletin every few days. Quantify the real median gap between
> genuine value changes per rice category (not calendar days). Write a short, cited finding
> (numbers + source) I can drop into the paper, and tell me clearly whether the flat-lining
> originates upstream (source data) or in `ffill().bfill()` during the merge.

---

## Phase 2 — Fix the Target Definition

**Goal:** Stop baseline getting free credit for predicting duplicate rows; give the model a
fair fight on the days that actually matter.

**What to do**
1. Re-run the existing evaluation (persistence, ARIMA, LSTM) with duplicate/forward-filled rows
   excluded from the scored set — evaluate only on genuine price-change events.
2. If Phase 1 shows a real underlying cadence (e.g. "DA updates roughly every 5–7 days"),
   consider training/evaluating at that cadence instead of forcing daily granularity — the
   public-facing forecast can still be presented daily, but the *model* shouldn't be trained to
   predict artificial constancy.
3. Compare: does the LSTM's advantage over persistence look any different once duplicates are
   removed from the scoring? (Your existing "shock" test at meta.json is a partial version of
   this — extend it to *all* genuine-change days, not just the top 90th-percentile moves.)

**Phase 2 prompt:**
> Using the root cause from Phase 1, rebuild the train/val/test evaluation in `model/train.py`
> so persistence, ARIMA, and the LSTM are scored only on genuine price-change events (exclude
> forward-filled duplicate rows from the scoring, not necessarily from the input sequence).
> Report MAE/RMSE/MAPE for all three approaches on this corrected evaluation set, per category,
> next to the old (duplicate-inflated) numbers so I can see the difference directly.

---

## Phase 3 — Strengthen the Signal

**Goal:** Give the model features that actually have lead time on genuine price moves — only
worth doing once Phase 2's fairer evaluation is in place.

**What to do**
1. Test lag-correlation of `farmgate` against genuine retail price changes (does farmgate move
   days before retail actually does?).
2. Add features with real known lead time: your own `tariff_schedule` quarterly rate changes
   (a structural break you already know the date of in advance for imported categories), and
   consider an international benchmark (FAO/Vietnam 5% broken price, already referenced in your
   tariff logic) as an exogenous driver.
3. Re-test each candidate feature's correlation against genuine-change days only (from Phase 2),
   not the full duplicate-inflated series — a feature can look useless against 90% flat data and
   useful against the 10% that actually moves.

**Phase 3 prompt:**
> Test whether `farmgate`, tariff-quarter changes (from `tariff_schedule`), and an FAO/Vietnam
> 5% broken benchmark price have real lag-correlation with genuine retail price changes
> (excluding forward-filled duplicate days, per Phase 2). Report the correlation and lead time
> for each candidate. For any that show real signal, add them to `FEATURE_COLUMNS` in
> `model/data_pipeline.py` and retrain, keeping everything else constant so I can see the
> isolated effect of each new feature.

---

## Phase 4 — Rigorous Re-Validation

**Goal:** Make sure any improvement is real, not a lucky training run or an artifact of the new
evaluation setup.

**What to do**
1. Re-run the full existing suite (chronological split, rolling-origin, shock test, ARIMA
   comparison, ADF) on the Phase 2/3 setup.
2. Add a statistical significance test (e.g. Diebold-Mariano) on the MAE difference between
   LSTM and persistence/ARIMA — "0.01 pesos lower MAE" means nothing without this; a
   significant result is a real, defensible claim.
3. Retrain with 3–5 different random seeds and report the spread — one good run is not
   evidence; consistent improvement across seeds is.

**Phase 4 prompt:**
> Re-run the full evaluation suite from `model/train.py` (chronological split, rolling-origin,
> shock test, ARIMA(1,1,1) comparison, ADF stationarity) on the Phase 2/3 pipeline. Add a
> Diebold-Mariano test comparing LSTM vs. persistence and LSTM vs. ARIMA MAE, per category.
> Retrain with 3-5 different random seeds and report the MAE spread across seeds, not just one
> run. Update `model/meta.json` with the new metrics, keeping the old ones for comparison.

---

## Phase 5 — Honest Repackaging for Defense

**Goal:** Whatever the true final result is, present it clearly and defensibly.

**What to do**
1. Update `README.md`/`documents/PAPER_CORRECTIONS.md` with the real, final claim — if it now
   beats baseline with significance, say so with the numbers; if it still doesn't, the upgraded
   honest claim is "we identified and corrected a genuine data-granularity artifact in DA
   reporting, redefined evaluation around real price-change events, and rigorously
   re-benchmarked with significance testing" — a materially stronger finding than "prices are
   unpredictable," even without a clean win.
2. Build one before/after comparison (Phase 1's original numbers vs. Phase 4's final numbers)
   for the defense — a panel reacts far better to "here's what we found, here's what we fixed,
   here's the honest result" shown visually than to a paragraph of caveats.

**Phase 5 prompt:**
> Update `model/meta.json`, `README.md`, and `documents/PAPER_CORRECTIONS.md` to reflect the
> final Phase 4 results honestly — state clearly whether the model now beats baseline with
> statistical significance, and on how many/which categories. Build a simple before-vs-after
> table (original duplicate-inflated metrics vs. final corrected metrics) I can put directly
> into my defense slides.

---

## What "4.5/5" actually requires

Not just re-running numbers — the full chain: root cause *proven* (not assumed), evaluation
*fixed* to be fair, a genuine attempt at *better signal*, and any resulting claim backed by
*significance testing across multiple runs*. Do all five and report exactly what you found —
that combination of rigor and honesty is what moves the score, whether or not the final MAE
literally edges out persistence.

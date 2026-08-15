# Chapter 3 — Methodology Additions (Defense Round 2)

Ready-to-paste text for the capstone paper, matching the implemented system. Paste each block
into the indicated Chapter 3 location in `AgriPrice_Draft_Revised.docx` (keeping your Word
heading styles). **[VERIFY]** marks values that need official confirmation — do not submit them
as fact until confirmed. Decisions applied: **DA-AMAS retained** for rice price data/monitoring;
**DTI added** for category/brand verification and as an evaluator group. **N ≈ 100 → n = 80**
(assumption, [VERIFY] with your actual population frame).

---

## Insert into "Population and Sampling" (before the "A total of ... respondents" paragraph)

### Sample Size Determination (Slovin's Formula)

The sample size was computed using **Slovin's formula**:

> **n = N / (1 + N·e²)**

where *n* is the required sample size, *N* is the total population of target stakeholders, and
*e* is the margin of error, set at **e = 0.05** (95% confidence). Given an estimated stakeholder
population of **N = 100** [VERIFY], the computation is:

> n = 100 / (1 + 100 × 0.05²) = 100 / (1 + 0.25) = 100 / 1.25 = **80**

Therefore, a minimum of **80 respondents** is required — satisfying the panel's requirement of at
least 80 evaluators. For reference, larger populations yield: N = 120 → n = 92; N = 150 → n = 109;
N = 200 → n = 134.

**[VERIFY / ACTION]** State the actual target population N used to derive n. If N differs from 100,
recompute n with the formula above.

## Replace the "A total of eighty (80) respondents ..." paragraph with:

A total of **eighty (80) respondents**, determined via Slovin's formula (e = 0.05, N ≈ 100),
participated in the User Acceptance Testing, distributed across the following stakeholder strata:

| Respondent group | n | Sampling method |
|---|---|---|
| Household managers / consumers | 30 | Stratified random |
| Local vendors / rice distributors | 25 | Stratified random |
| IT professionals (evaluators) | 15 | Purposive |
| DTI personnel | 10 | Purposive |
| **Total** | **80** | — |

The community strata (households, vendors/distributors) were drawn through **Stratified Random
Sampling**, while the expert strata (IT professionals, DTI personnel) were selected through
**Purposive Sampling** (Creswell & Creswell, 2023). **DTI personnel** validate the rice category
and brand classifications and evaluate the system; the **Department of Agriculture (DA-AMAS)**
remains the source of the daily rice price data used by the forecasting engine.
**[VERIFY / ACTION]** Confirm the actual per-stratum headcounts.

---

## Insert into "Statistical Treatment of Data" (after the Standard Deviation subsection)

### One-Way Analysis of Variance (One-Way ANOVA)

To determine whether the perceived quality of the AgriPrice system differs across the respondent
groups, this study employs **One-Way ANOVA**. The independent (grouping) variable is the respondent
group (households, distributors, IT professionals, DTI personnel); the dependent variable is each
respondent's mean evaluation score on the 4-point Likert scale (overall ISO 25010 / usability
rating). The hypotheses are:

- **H₀:** μ₁ = μ₂ = μ₃ = μ₄ — there is no significant difference in the mean evaluation ratings
  across the respondent groups.
- **H₁:** at least one group mean differs significantly from the others.

The test is evaluated at a significance level of **α = 0.05**. The **F-statistic** and its
associated **p-value** are computed; if **p < 0.05**, the null hypothesis is rejected, indicating
that perceptions of the system differ significantly across groups, and a **post-hoc Tukey HSD**
test identifies which specific groups differ. If p ≥ 0.05, the system is interpreted as being
perceived consistently across all stakeholder groups. Prior to interpretation, the ANOVA
assumptions are checked: **homogeneity of variance** (Levene's test) and **normality**
(Shapiro–Wilk test). Where these assumptions are violated, **Welch's ANOVA** or the non-parametric
**Kruskal–Wallis** test is used instead and reported accordingly. Weighted Mean and Standard
Deviation are retained as descriptive statistics alongside the inferential ANOVA.

---

## Insert into the accuracy/technical-validation portion of "Statistical Treatment" / "Testing"

### Forecast-Accuracy Metrics

The predictive accuracy of the multivariate LSTM model is evaluated on a **chronologically
held-out test set** (70% train / 15% validation / 15% test, no shuffling) using the following
complementary metrics:

- **Mean Absolute Error (MAE)** — the average magnitude of forecast error in Philippine pesos per
  kilogram; the primary, most interpretable accuracy indicator.
- **Root Mean Squared Error (RMSE)** — penalizes large or anomalous errors more heavily than MAE.
- **Mean Absolute Percentage Error (MAPE)** — expresses error as a scale-free percentage,
  enabling comparison across rice categories with different price levels.
- **Coefficient of Determination (R²)** — the proportion of price variance explained by the model.
- **Rolling-origin evaluation** — the MAE computed across successive chronological blocks of the
  held-out test set, assessing temporal robustness (stability of accuracy over time).

To establish whether the LSTM's added complexity is justified, its metrics are **benchmarked
against a naive-persistence baseline** (forecast = last observed price) and an **ARIMA(1,1,1)**
baseline, and the target series' stationarity is assessed with the **Augmented Dickey-Fuller (ADF)**
test.

**Interpretation note (report honestly).** On the held-out test set the model attains a low MAE
(≈ ₱0.24/kg) and MAPE (≈ 0.5%). The R² is high (≈ 0.99); however, because retail rice prices are
strongly trended and highly autocorrelated, a naive persistence forecast attains a similarly high
R². Consequently, **R² should not be presented as evidence of superiority**; the meaningful
comparison is MAE/RMSE **relative to the persistence and ARIMA baselines**. The Augmented
Dickey-Fuller test indicates the series is non-stationary (p ≈ 0.07), i.e., near a random walk at
the 1–3 day horizon — a regime in which no model, statistical or deep-learning, is expected to
substantially outperform persistence. The multivariate LSTM's contribution is therefore framed as
a **unified, multivariate forecasting system across all eight rice categories that matches
established baselines**, rather than a claim of beating them.

---

## Insert into "Scope and Limitations" / Data description

- **Price brackets.** Retail rice prices are represented as **price ranges (minimum–maximum)**
  rather than single values, consistent with how prevailing prices are reported. The forecasting
  model produces a point estimate (bracket midpoint) presented with an accompanying range.
  **[VERIFY: DTI]** whether official prices are published as true min–max brackets or must be
  derived from the observed multi-market spread.
- **Imported-rice taxes and import charges.** The consumer price of **imported** rice incorporates
  applicable **import charges** — the tariff under the Rice Tariffication Act (RA 11203; the reduced
  rate under EO 62, s. 2024), **VAT**, and other Bureau of Customs fees. **[VERIFY: BOC/BIR/DTI]**
  confirm the current, applicable rates before reporting them.
- **DTI category and brand alignment.** The eight rice categories (Local/Imported × Special,
  Premium, Well-Milled, Regular-Milled) and the brands under each are validated against the
  **Department of Trade and Industry (DTI)**. **[VERIFY: DTI]** confirm the official category
  labels and the brand membership of each category.

---

## Where these are already reflected in the system
- Slovin, One-Way ANOVA (with Tukey/assumption checks), and the accuracy metrics are implemented
  in `research/stats.py` — run `py -3.13 research/stats.py --selftest` and `--slovin 100`.
- MAE/RMSE/MAPE/R²/rolling-origin + persistence/ARIMA/ADF/shock appear in `model/meta.json` and
  the admin **Metrics** page.
- The DTI category catalog, price-bracket, and tax schema exist (`datasets/catalog_schema.py`) and
  are surfaced in the admin **Rice Catalog & Taxes** page; they hold the [VERIFY] data once obtained.

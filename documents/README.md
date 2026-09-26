# Documents — capstone paper tracked against the app

This folder version-controls the capstone document alongside the source code so the
paper and the implementation can be traced to each other over time.

| File | What it is |
|------|------------|
| `AgriPrice_Draft_Revised.docx` | The **current** capstone paper, corrected to match the built system. Commit a new version here whenever the paper changes so its history lives beside the code. |
| `PAPER_CORRECTIONS.md` | The **app ↔ paper reconciliation log**: what was changed in the code, what still needs editing in the paper, and how to frame the model-evaluation results honestly. This is the map between the two. |

## How to keep them in sync
- When the **app** changes in a way the paper describes (features, data sources, horizon,
  metrics), update `PAPER_CORRECTIONS.md` and, if the wording is affected, the `.docx`.
- When the **paper** is revised, replace `AgriPrice_Draft_Revised.docx` with the new version
  and commit — `git log -- documents/AgriPrice_Draft_Revised.docx` then shows the paper's history.
- Because `.docx` is a binary, GitHub won't show line diffs; use the commit history to fetch
  any prior version. `PAPER_CORRECTIONS.md` is the human-readable change record.

## Current state (2026-09-27)
The paper and app agree on: 8 rice types, the 2015–2026 DA record (weekly before 2025, daily from
April 2025 — disclosed in Chapter 3 and the limitations), 48–72h (3-day) horizon, min-max scaling,
last-observed-value gap handling, the regime-aware chronological split, naive and ARIMA(1,1,1)
baselines, DA-AMAS PDF ingestion, dual admin/public interface, and the deployed forecaster (an
LSTM-based adaptive ensemble: skill +10.06% vs naive, beats ARIMA on 8/8, while the LSTM network alone
shows no significant contribution). The `.docx` also carries a draft Chapter 4 and 5 (technical parts)
generated from `model/meta.json`. Remaining team-only edits are flagged in red in the `.docx`
(UAT headcounts and survey results, synthesis matrix, sprint evidence, conceptual-framework diagram,
references) — see the latest section of `PAPER_CORRECTIONS.md`.

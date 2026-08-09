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

## Current state (as of this commit)
The paper and app agree on: 8 rice types, 15-year (2015–2025) daily data, 48–72h (3-day)
horizon, min-max scaling, last-observed-value gap handling, chronological 70/15/15 split,
DA-AMAS PDF ingestion, dual admin/public interface, and the honest evaluation result
(LSTM ≈ naive persistence ≈ ARIMA at this horizon). See `PAPER_CORRECTIONS.md` for the
per-item detail and the remaining team-only edits (UAT headcounts, synthesis matrix).

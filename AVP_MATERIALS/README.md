# AVP Materials — AgriPricePH

Everything the team needs to make the AVP and to explain the system: what it does, where the data comes from, how
the forecast works, how accurate it is, and how to answer the panel. Numbers are as of **Oct 27, 2026** (model
retrained Oct 7, 2026; comparison window Oct 7 – Oct 26, 2026).

| File | What is in it | Read it when |
|---|---|---|
| [01_SYSTEM_OVERVIEW.md](01_SYSTEM_OVERVIEW.md) | What AgriPricePH is, how it is built, every admin and public module | You need to describe the system |
| [02_DATA.md](02_DATA.md) | The 7 data sources, the 2015–present rice price history, how data is checked | Someone asks "where do the prices come from?" |
| [03_FORECAST_MODEL.md](03_FORECAST_MODEL.md) | How a forecast is made: inputs, the 3 models, weights, price range | You explain the model |
| [04_RESULTS.md](04_RESULTS.md) | Accuracy on the test year, the Oct 7–26 comparison with and without factors, limits | You quote a number |
| [05_AVP_SCRIPT_1M45.md](05_AVP_SCRIPT_1M45.md) | The 1:45 video: scene list, TTS narration, what to record | You make the video |
| [06_PANEL_QA.md](06_PANEL_QA.md) | Short answers to the questions the panel is likely to ask | Before the evaluation |
| [07_AVP_PRODUCTION_PLAN.md](07_AVP_PRODUCTION_PLAN.md) | **What to do, step by step:** prepare the system, voice, recordings (file names), graphics, edit, final check | You plan the video |
| [08_BRIEF_FOR_VIDEO_EDITOR.md](08_BRIEF_FOR_VIDEO_EDITOR.md) | **Paste this to the video-editing Claude:** inputs, edit decision list with timings, rules | You hand off the editing |
| [captions.srt](captions.srt) | Captions for the narration (re-time to the real audio) | Editing |
| `assets/` | Put the recordings, audio, graphics here; the final video goes in `assets/export/` | Production |

**Order:** 07 (plan) → record and voice → 08 + `assets/` to the editing Claude → check with 07 step 6.

**The one-sentence version:** AgriPricePH collects official rice, fuel, exchange-rate and economic data every day,
and forecasts the retail price of 8 rice types in Metro Manila up to 3 days ahead; on 20 days it never saw, its
next-day forecast was off by ₱0.21 per kilo on average and within ₱1 on 99% of days.

**Three things never to say:** that the LSTM alone beats ARIMA or "tomorrow = today" (the combined model does);
that the factors make the forecast more accurate (with and without them the forecast is almost identical); or an
"accuracy" of 98–99% (a misleading legacy figure). See 04_RESULTS.md.

Sources inside the project, if more detail is needed: `CLAUDE.md`, `SYSTEM_GUIDE.txt`,
`documents/PAPER_CORRECTIONS.md`, `datasets/README.md`, `model/meta.json`.

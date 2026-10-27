# 8. Brief for the video editor (paste this to the editing Claude)

## Context
AgriPricePH is a capstone web system that monitors and forecasts the **retail price of 8 rice types in Metro Manila**
up to 3 days ahead, from official Department of Agriculture (DA) data. This video goes to an evaluator. Its job: show
what the system does and **prove the forecast works**, by replaying 20 real days (Oct 7 – Oct 26, 2026) where the
real price moves and the forecast made the day before follows it, with and without the economic factors.

## Deliverable
- `assets/export/AgriPricePH_AVP.mp4`: 1920×1080, 30 fps, H.264 + AAC, **1:35 – 1:45**.
- Burned-in captions from `captions.srt` (bottom center, white, dark semi-transparent box).
- Clean, professional, calm. No flashy transitions: cuts or 8-frame crossfades only.

## Inputs (in `assets/`)
- `audio/block1.wav` … `block5.wav` (or `narration_full.wav`): the voice. **The voice sets the timing. Never speed
  it up or cut words.**
- `recordings/01_public_forecast.mp4` … `06_forecast_card.mp4`: screen recordings (see `07_AVP_PRODUCTION_PLAN.md`).
- `graphics/title.png`, `graphics/end_card.png`.
- Optional soft background music at about −25 dB under the voice; none is better than a busy track.

## Edit decision list (timings assume 150 wpm; re-time to the real audio)
| # | Time | Audio | Video | On-screen text (lower-third, 3–4 s) |
|---|---|---|---|---|
| 1 | 0:00 – 0:02 | — | `title.png`, fade in | — |
| 1 | 0:02 – 0:13 | block 1 | `01_public_forecast.mp4` | "8 rice types · Metro Manila · retail price · 3-day forecast" |
| 2 | 0:14 – 0:23 | block 2 (first half) | `02_data_sources.mp4` | "7 official sources, collected automatically" |
| 2 | 0:23 – 0:30 | block 2 (second half) | `03_web_scraper.mp4` | — |
| 3 | 0:31 – 1:12 | block 3 | `04_replay_LocalWellMilled.mp4` (the main shot; trim the start so purple points begin when the voice says "Each purple point") | at start: "Oct 7 – 26, 2026 · 20 days the model never saw" |
| 3 | 0:56 – 1:12 | block 3 ("The orange line…" to "…barely change it") | `04b_without_factors.mp4`: With only → Without only → Both | "Without factors: almost the same forecast" |
| 3 | 1:12 – 1:18 | block 3 (last sentences) | `05_replay_summary.mp4` | "Average error ₱0.21 · within ₱1 on 99% of days · with and without factors: almost identical" |
| 4 | 1:19 – 1:33 | block 4 | `06_forecast_card.mp4` | "Price range + strongest model today" |
| 5 | 1:34 – 1:43 | block 5 | `end_card.png`, fade out at the end | — |

## Emphasis inside the main shot (scene 3)
- When the voice says "purple point", add a soft circle highlight on the first purple point for 1.5 s.
- When it says "green line", highlight the green line's newest point.
- When it says "orange line", highlight where orange and purple overlap.
- If the replay clip is shorter than the narration, slow it to 80–90% or hold the last frame; if longer, trim the
  middle days, never the last ones.
- Keep the chart readable: you may zoom to 110–125% on the chart area, but keep the legend and dates visible.

## Rules (do not break)
- Do not change, round differently, or add any number. The only numbers: 8 rice types, 3 days, 7 sources, Oct 7 – 26,
  20 days, ₱0.21, 99%.
- Do not add claims (e.g. "AI predicts prices perfectly", "factors improve accuracy"). The voice says the factors
  barely change the forecast; keep visuals consistent with that.
- Do not show passwords, PINs, emails, or error screens.
- Colors for any graphic: dark green #1C3D28, green #2D8A50, light green #4CAF6E, purple #8B5CF6, orange #F59E0B,
  white text.

## Narration text (for captions and timing reference)
See `captions.srt` and `05_AVP_SCRIPT_1M45.md` (section 2). Background on the system: `01`–`04` in this folder.

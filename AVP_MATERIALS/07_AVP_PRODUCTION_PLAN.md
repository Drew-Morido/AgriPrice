# 7. AVP production plan (what to do, in order)

**Goal:** a 1:35 – 1:45 video that shows what AgriPricePH does and **how the rice price moves against the forecast,
with and without the factors, over 20 days (Oct 7 – Oct 26, 2026)**.
**Final file:** `assets/export/AgriPricePH_AVP.mp4`, 1920×1080, 30 fps, H.264, AAC audio, with burned-in captions.

## Step 1 — Prepare the system (15 min)
1. Start the backend (`start_agriprice.bat` or `cd api && py -3.13 app.py`) and wait for one scrape.
2. Admin → Data Sources must show **7/7**.
3. Open Admin → **Forecast vs Actual** once and wait until the top right says "Updated …".
4. Browser: full screen (F11), zoom 100%, light theme, one tab, notifications off. Super Admin account.

## Step 2 — Generate the voice (Google AI Studio, 10 min)
- Model: Gemini 2.5 Pro Preview TTS. Voice: **Charon** (or Sadaltager / Iapetus).
- Scene: *A professional software demonstration video for an IT expert evaluating a capstone project. A calm, confident
  narrator explains a rice price forecasting system while screen recordings play.*
- Sample Context: *Speak in clear, neutral English with a steady, unhurried pace, like a product walkthrough. Pause
  briefly between sentences. Confident, informative tone, no excitement or laughter. Read acronyms letter by letter
  (D A, P S A, D O E, L S T M). Say "Agri Price P H" for the product name.*
- One speech block per narration block (5 blocks, `05_AVP_SCRIPT_1M45.md`). Export each block as its own file:
  `assets/audio/block1.wav` … `block5.wav` (or one `narration_full.wav`).
- Check the total: 1:35 – 1:45. If longer, ask for a slightly faster pace; never cut words that carry numbers.

## Step 3 — Record the screen (20–30 min)
Record each clip separately with OBS Studio (1920×1080, 30 fps). Save with these names in `assets/recordings/`:

| File | Length to record | What to do on screen |
|---|---|---|
| `01_public_forecast.mp4` | 12 s | Public Price Forecast page (`/public/current-prices.html`): slow scroll over the 8 prices, hover the "Tomorrow" card |
| `02_data_sources.mp4` | 10 s | Admin → Data Sources: point at "Connected sources 7/7", click DA, then Core inflation, then World rice price |
| `03_web_scraper.mp4` | 8 s | Admin → Web Scraper: schedule rows, then the Activity Log |
| `04_replay_LocalWellMilled.mp4` | 52 s | Admin → **Forecast vs Actual**: rice type Local Well-Milled, From Oct 7 2026, To Oct 26 2026, speed **Slow (for video)**. Start recording, wait 1 s, press **Play**, keep the mouse still until the last day, wait 2 s |
| `05_replay_summary.mp4` | 6 s | Same page after the replay: the three summary cards, then scroll to the "All 8 rice types" table |
| `06_forecast_card.mp4` | 14 s | Admin → Price Forecast: the 3-Day Price Forecast card, hover the (i) of "Forecasting models today" so the explanation shows, then the Next Day Prediction range |

Never show a password, PIN, `.env`, or a user's email. Record the login separately only if needed (not in this cut).

## Step 4 — Make the graphics (Canva or PowerPoint, 15 min) → `assets/graphics/`
| File | Content |
|---|---|
| `title.png` | "AgriPricePH" · "Rice Price Monitoring and Forecasting" · small line: "8 rice types · Metro Manila · retail price" |
| `end_card.png` | "AgriPricePH" · team names · school · adviser · "Thank you" |
| Lower-thirds | Text in section 3 of `05_AVP_SCRIPT_1M45.md` (white text on a dark green bar, #1C3D28) |

Brand colors: dark green #1C3D28, green #2D8A50, light green #4CAF6E; forecast purple #8B5CF6, price-only orange
#F59E0B (same as the chart). Font: Plus Jakarta Sans (the admin's font) or similar.

## Step 5 — Edit (another Claude, or CapCut / Clipchamp)
Give the editor `08_BRIEF_FOR_VIDEO_EDITOR.md` and the `assets/` folder. The edit decision list is there.

## Step 6 — Check before submitting
- Length 1:35 – 1:45; voice never sped up.
- Every number on screen matches the voice: ₱0.21 average error, within ₱1 on 99% of days, Oct 7 – 26, 20 days.
- The replay is visible long enough to see purple points appear before green ones.
- Captions present and in sync (`captions.srt`).
- No passwords, PINs, emails, or error messages in any frame.

## Who does what
| Task | Who |
|---|---|
| Steps 1, 3 (recordings) | Team member with the laptop running the system |
| Step 2 (voice) | Anyone with Google AI Studio |
| Step 4 (graphics) | Anyone with Canva |
| Step 5 (edit) | Video-editing Claude, using the brief |
| Step 6 (check) | Whole team, before submitting |

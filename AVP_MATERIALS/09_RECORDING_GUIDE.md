# 9. Recording guide (what to record, click by click)

You record **5 screen clips** (about 10–15 minutes in total, retakes included). I make the animated replay, the
graphics, the captions and the final edit. Save every clip in `assets/recordings/` with the exact file name.

---

## A. Set up once (5 minutes)

**1. Install OBS Studio** (free): obsproject.com → Download → Windows. Open it; if it asks for the Auto-Configuration
Wizard, choose "Optimize just for recording".

**2. OBS settings** (Settings, bottom right):
- **Video:** Base (Canvas) Resolution `1920x1080`, Output (Scaled) Resolution `1920x1080`, Common FPS `30`.
- **Output → Recording:** Recording Format `mp4`, Recording Path → `...\AgriPrice\AVP_MATERIALS\assets\recordings`.
- **Audio:** set Desktop Audio and Mic/Aux to **Disabled** (no sound in the clips; the voice is added later).

**3. Add the screen:** in Sources, click **+** → **Display Capture** → OK → choose your main monitor → OK.
If the preview is black on a laptop, use **Window Capture** and pick the browser window instead.

**4. Your screen:** if your monitor is not 1920×1080, set it to 1920×1080 (Windows Settings → Display → Display
resolution) for the recording, and Scale to 100%.

**5. The system:**
- Start AgriPricePH (`start_agriprice.bat`) and wait about a minute.
- Open Chrome or Edge at `http://127.0.0.1:5000/`. Log in to the admin with your **Super Admin** account.
- Press **F11** (full screen). Zoom 100% (press Ctrl+0). Light theme.
- Close other tabs. Turn on Windows **Focus assist / Do not disturb** so no notification pops up.
- Admin → **Data Sources** must say **7/7**. Admin → **Forecast vs Actual** must say "Updated …" at the top right.

**How to record each clip:** get the page ready first → click **Start Recording** in OBS → wait **2 seconds** without
moving → do the actions slowly → wait **2 seconds** → **Stop Recording**. Rename the new file in
`assets/recordings` to the name below. Extra seconds at the start and end are fine; I trim them.

**Mouse rules:** move slowly and smoothly, like pointing for someone beside you. Pause about 1 second on everything you
point at. Do not circle or shake the mouse. Never type a password or PIN while recording.

---

## B. The 5 clips

### Clip 1 — `01_public_forecast.mp4` (about 15 s)
*Shows: what the public sees.*
1. Before recording: open a new tab at `http://127.0.0.1:5000/public/current-prices.html` (F11 full screen). You do
   **not** need to be logged in here. Wait until all prices have loaded. Scroll to the very top.
2. Start recording, wait 2 s.
3. Move the mouse slowly over the rice types in the left list (Well-Milled, Regular Milled, Special, Premium).
4. Hover the **TOMORROW** card on the right for 2 seconds (the forecast range).
5. Scroll down slowly to the chart and stop there for 2 seconds.
6. Wait 2 s, stop recording.

### Clip 2 — `02_data_sources.mp4` (about 15 s)
*Shows: the 7 official sources, collected automatically.*
1. Before recording: Admin → **Data Sources**. Make sure DA is selected (top of the list).
2. Start recording, wait 2 s.
3. Point at **Connected sources 7/7** at the top for 2 seconds.
4. In the left list, click **Rice prices (DA)** → wait 2 s.
5. Click **Core inflation** → wait 2 s (let the "Used by the model from …" value be visible).
6. Click **World rice price** → wait 2 s.
7. Wait 2 s, stop recording.

### Clip 3 — `03_web_scraper.mp4` (about 12 s)
*Shows: automatic data collection.*
1. Before recording: Admin → **Web Scraper**. Scroll to the top.
2. Start recording, wait 2 s.
3. Point at the cards at the top (DA Rice Bulletin 8/8, DOE Fuel, Exchange Rates) for 2 seconds.
4. Move to the **Scraper Schedule** list on the right and slowly go down the source names (DA … World Bank).
5. Move to the **Activity Log** on the left for 2 seconds.
6. Wait 2 s, stop recording.

### Clip 4 — `04_replay_LocalWellMilled.mp4` (about 55 s) — the real system doing the replay
*Shows: the actual page in the system. I also make a sharper animated version from the same data and use the best of
the two.*
1. Before recording: Admin → **Forecast vs Actual**. Check: Rice type **Local Well-Milled**, From **10/07/2026**, To
   **10/26/2026**. Replay speed **Slow (for video)**. If the replay was played before, click **Show all** first.
2. Scroll so the **chart** and the line of text above it are fully on screen (the three summary cards can be just above).
3. Start recording, wait 2 s.
4. Click **Play**. Then **move the mouse off to the side** (bottom right corner) and **do not touch it** until the last
   day (Oct 26) appears, about 48 seconds.
5. Wait 3 s, stop recording.

### Clip 4b — `04b_without_factors.mp4` (about 15 s) — the forecast WITHOUT factors, on its own
*Why: the two forecasts differ by about ₱0.01, so in clip 4 the orange line hides under the purple one. The page now
has a **Show** selector to display each one alone.*
1. Before recording: same page and settings as clip 4, after the replay (or click **Show all**). Chart on screen.
2. Start recording, wait 2 s.
3. Click **Show** → **With factors only** → wait 3 s (purple + green).
4. Click **Show** → **Without factors only** → wait 3 s (orange + green, almost the same shape).
5. Click **Show** → **Both forecasts** → wait 3 s (the orange band sits right under the purple line).
6. Scroll down slowly to the **Day by day** table (columns With factors / Without factors) and stop 3 s.
7. Wait 2 s, stop recording. Use it while the voice says "The orange line is the same forecast without the factors…".

### Clip 5 — `06_forecast_card.mp4` (about 15 s)
*Shows: today's forecast, the price range, and which model is strongest today.*
1. Before recording: Admin → **Price Forecast**. Scroll to the top. Local is selected.
2. Start recording, wait 2 s.
3. Point at the four price cards for 2 seconds.
4. Point at **Strongest today: …** and the colored bar for 2 seconds.
5. Hover the small **(i)** next to "FORECASTING MODELS TODAY" and keep the mouse still for **4 seconds** so the
   explanation stays open.
6. Move down to **Next Day Prediction** (the ₱ low – high range) for 2 seconds.
7. Wait 2 s, stop recording.

You no longer need `05_replay_summary.mp4`: I render the summary from the data.

---

## C. Voice (Google AI Studio, about 10 minutes)
Settings and the 5 blocks are in `07_AVP_PRODUCTION_PLAN.md` (Step 2) and `05_AVP_SCRIPT_1M45.md`. Download each
block and save it as `assets/audio/block1.wav` … `block5.wav` (an `.mp3` is fine too).

---

## D. Before you send them to me
- [ ] 5 clips in `assets/recordings/` with the exact names: `01_public_forecast`, `02_data_sources`,
      `03_web_scraper`, `04_replay_LocalWellMilled`, `06_forecast_card`.
- [ ] 5 audio files in `assets/audio/`.
- [ ] Watch each clip once: no password, PIN, email, error message, notification, or other window visible; the mouse
      is not shaking; nothing is cut off.
- [ ] Then tell me "nandiyan na" and I will build the final video.

**If something goes wrong:** just record that clip again and overwrite the file. A clip with a mistake in the middle can
also stay; tell me which second to cut.

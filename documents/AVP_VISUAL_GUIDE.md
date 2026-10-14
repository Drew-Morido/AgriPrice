# AgriPricePH — AVP visual guide (what to record, click, and type)

Matches the 9 speech blocks of `AVP_QUICK_SCRIPT.md` (about 2:51 at 150 wpm). Times are approximate: generate the
audio first, then cut each clip to its block.

## 0. Setup before recording

| Do this | Why |
|---|---|
| `cd api && py -3.13 app.py`, then open `http://127.0.0.1:5000/api/health` (must say `"status":"ok"`) | The backend is not running by default; every page needs it |
| Wait for one full scrape (Admin → Web Scraper → **Run Now**, about 1 min). Record after today's DA bulletin is in (the DA card says "Estimated" until then) | Data Sources shows 7/7 and the log has fresh lines |
| Use your own **Super Admin** account. Make one **public test account** (Sign up) for the public clips | Admin clips need every module; Price History and Charts & Stats ask a visitor to sign in |
| Run the tests with the backend running: `py -3.13 -m pytest tests -q` and keep the terminal open | Block 8 shows the result. Use the number it prints (not 198 if different) |
| Record the training clip ahead: Admin → Model Training → **Start Training**, record about 10 s of the live log and loss curve, then let it finish | Training takes several minutes |
| Screen: 1920×1080, 30 fps, browser full screen (F11), zoom 100%, light theme, bookmarks bar hidden, one tab, Windows Focus Assist on | Clean, consistent frames |
| Tools: **OBS Studio** (record), **Canva** or PowerPoint (title and diagram cards), **CapCut** or Clipchamp (edit) | All free |

Never show: passwords, the PIN, `.env`, a user's email (blur it in the editor), or the browser's saved-password popup.

## 1. Shot list

Each row is one clip. "Type" is what to enter; "Click" is where to go.

### Block 1 — Intro (0:00 – 0:21)
| Time | Show | Do |
|---|---|---|
| 0:00 – 0:04 | **Title card** (make in Canva) | Text: "AgriPricePH", "Rice Price Monitoring and Forecasting System", "8 rice types · Metro Manila · 3-day forecast" |
| 0:04 – 0:21 | Landing page `http://127.0.0.1:5000/public/landpage.html` | Scroll slowly: hero → features → price preview. Overlay: "Flask · SQLite · TensorFlow" |

### Block 2 — Login and dashboard (0:22 – 0:36)
| Time | Show | Do |
|---|---|---|
| 0:22 – 0:28 | `public/login.html` | Click **Log in**. Type your admin username, then the password (it shows as dots). The code step appears: **cut the clip before you type the PIN**, or blur the field. Overlay: "Password + 6-digit PIN" |
| 0:28 – 0:36 | Admin → **Dashboard Overview** | Hover each card in order: Today's Rice Prices → Rice Price Predictions → Forecasts within ₱1.00 → Average Forecast Error → Diesel → USD/PHP → 90-day trend |

### Block 3 — Data collection (0:37 – 1:07)
| Time | Show | Do |
|---|---|---|
| 0:37 – 0:44 | Admin → **Data Sources** | Point at "Connected sources **7/7**" |
| 0:44 – 0:55 | Same page | Click **DA**, then **Core inflation**, then **World rice price**, about 3 s each. Pause on Core inflation's "Used by the model from". Overlay: "7 official sources" |
| 0:55 – 1:03 | Admin → **Web Scraper** | Point at the Scraper Schedule rows (7 sources) and the next run. Overlay: "Sync every 24 h · DA retry every 2 h" |
| 1:03 – 1:07 | Same page | Scroll to the **Activity Log** (recorded during Run Now), then the **Held for review** card. Overlay: "Suspicious prices held for review" |

### Block 4 — History and drivers (1:08 – 1:23)
| Time | Show | Do |
|---|---|---|
| 1:08 – 1:13 | Admin → **Price History** | Category **All**, period **All**: the chart from 2015 to today. Overlay: "Every price traced to PSA or DA" |
| 1:13 – 1:17 | File Explorer: `datasets\1_factor_csv\rice_retail_prices_daily.csv` | Open in Excel, zoom on the `source` column (psa_openstat_monthly, da_daily_bulletin…) |
| 1:17 – 1:23 | Admin → **Market Drivers** | Show the diesel-vs-rice chart, then the **Driver strength** list (Core Inflation and World Rice Price are in it). Do not scroll down to the summary table |

### Block 5 — Forecasting (1:24 – 1:57)
| Time | Show | Do |
|---|---|---|
| 1:24 – 1:31 | Admin → **Price Forecast** | Pick **Local Well-Milled**. Point at Next Day Prediction, the chart, and the low–high range in the Daily Forecast Table |
| 1:31 – 1:33 | Same page | Switch the rice type to **Imported Premium** |
| 1:33 – 1:40 | **Diagram card** | Boxes: "Last 30 days + market factors" → "LSTM + mean reversion", "ARIMA", "Kalman filter" → "Weighted by recent accuracy" → "3-day forecast + price range" |
| 1:40 – 1:46 | Admin → **Model Training** | Show the inputs, the Train / Validation / Test split, then the pre-recorded loss curve and log |
| 1:46 – 1:51 | Admin → **Model Dashboard** | Actual-vs-forecast chart |
| 1:51 – 1:57 | **Results card** | Four numbers: **96%** within ₱1 · **₱0.22–0.33** average error · **10.3%** lower error than "tomorrow = today" · **8 of 8** better than ARIMA. Footer: "Test year: Oct 2025 – Oct 2026" |

### Block 6 — Other admin modules (1:58 – 2:09)
Record one continuous clip, clicking down the sidebar, about 1.5 s per page, each with a small name label:
**Price Alerts → Reports & Export → Taxes & Import Charges → Rice Brands → User Management → System Settings → System Logs**

### Block 7 — Public website (2:10 – 2:32)
Log in as the **public test account** first, in a separate browser window.
| Time | Show | Do |
|---|---|---|
| 2:10 – 2:17 | `public/current-prices.html` | Hover the **Tomorrow** card: arrow (up, down, or steady) and the price range; then the 3-day chart |
| 2:17 – 2:20 | `public/historical.html` | Click **1Y** |
| 2:20 – 2:23 | `public/statistics.html` | Scroll the charts |
| 2:23 – 2:28 | `public/rice-catalog.html` | Open one **imported** brand: estimated shelf price with import charges |
| 2:28 – 2:32 | `public/signup.html` | Show the form and **Continue with Google**. Leave every field empty and do **not** submit |

### Block 8 — Security and reliability (2:33 – 2:45)
| Time | Show | Do |
|---|---|---|
| 2:33 – 2:37 | Admin → **User Management** | Show the Super Admin / Admin role labels. Blur the email column |
| 2:37 – 2:45 | Terminal | The finished `py -3.13 -m pytest tests -q`, ending on "198 passed". Zoom the last line |

### Block 9 — Closing (2:46 – 2:51)
**Title card:** "AgriPricePH — Rice Price Intelligence", team names, school, adviser. Fade out.

## 2. Editing

1. Import the TTS audio and place it on the timeline first.
2. Lay each clip under its block and trim to the block's length. If a clip is short, hold the last frame or slow it to
   80%. Never speed up the voice.
3. Add the overlays as lower-thirds (white text on a dark bar, 2–4 s each).
4. Add captions from the narration text (the evaluator may watch muted).
5. Export 1080p MP4. Check the length (2:30 – 3:00) and that every number on screen matches what the voice says.

## 3. Final check

- Data Sources shows 7/7 and no clip shows an error, a loading spinner, or "Backend unreachable".
- The numbers in the results card match Admin → Model Dashboard.
- No password, PIN, or email is visible in any frame.

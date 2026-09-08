================================================================================
  AgriPricePH v3 — README
  Rice price monitoring, 2-day LSTM forecast, public site + admin dashboard
================================================================================

Last updated: May 2026


================================================================================
  FOLDER STRUCTURE (ADMIN & PUBLIC SEPARATED)
================================================================================

AgriPricePH/
│
├── index.html                 → Redirects to public/landpage.html
│
├── public/                    ← VENDORS & HOUSEHOLDS (start here)
│   ├── landpage.html          Home
│   ├── current-prices.html    Today's prices (8 rice types)
│   ├── forecast.html          2-day forecast (8 rice buttons)
│   ├── historical.html        Price history (login required)
│   ├── statistics.html        Charts & stats (login required)
│   ├── login.html
│   ├── signup.html
│   ├── css/
│   │   ├── landpage.css
│   │   └── public.css
│   └── js/
│       ├── public-shell.js    Sidebar + topbar layout
│       ├── public-auth.js     User & admin login client
│       ├── public-data.js     Charts & price loading
│       ├── public-pages.js
│       └── public-rice.js     8 rice type definitions
│
├── admin/                     ← SYSTEM STAFF
│   ├── login.html             Admin sign-in (3-step + security)
│   ├── index.html             Main dashboard (session protected)
│   ├── pages/                 Admin module views (SPA)
│   ├── css/                   Admin module styles
│   └── js/                    Admin logic (router, training, …)
│
├── css/
│   └── global.css             Shared theme (both sites)
│
├── js/                        Shared scripts
│   ├── api.js                 Backend API client
│   ├── data.js                Fallback mock data
│   ├── charts.js
│   └── dates.js
│
├── api/                       Flask backend (port 5000)
├── model/                     ML train/predict, settings, admin_auth
├── datasets/                  SQLite + import scripts
├── tools/                     Web scraper (optional)
├── documents/                 Exported reports
├── requirements.txt
├── run_backend.bat
├── SYSTEM_GUIDE.txt           Full technical guide
└── README.txt                 This file


================================================================================
  WHERE TO OPEN IN THE BROWSER
================================================================================

  PUBLIC (everyone)
    http://localhost/AgriPricePH/public/landpage.html
    or:  http://localhost/AgriPricePH/          (root redirects)

  ADMIN (staff)
    Admin sign-in shares the public site's login — there is no separate admin login page.
    http://localhost/AgriPricePH/public/landpage.html  → click "Log in", use your admin account
    then: http://localhost/AgriPricePH/admin/index.html   (redirected there automatically)

  Via Flask only (port 5000):
    http://127.0.0.1:5000/                              → public home
    http://127.0.0.1:5000/admin/index.html               → admin dashboard (redirects to login if signed out)
    http://127.0.0.1:5000/public/login.html               → login page (admin sign-in works here too)


================================================================================
  ADMIN SIGN-IN
================================================================================

  There is no separate admin login page — sign in from the same "Log in" button as retailer
  accounts (public site nav, or the public-auth-modal.js unified login/signup modal). Enter your
  admin username + password there; a 6-digit access-code prompt follows automatically once the
  username/password are recognized as an admin account, then you're redirected into
  admin/index.html.

  Username: admin
  Password: Admin@123
  Code:     123456  (change in Admin → Settings → Security)

  Security:
    • Server-issued session token (not a simple browser flag)
    • 6-digit code stored as hash on server
    • 5 failed attempts → 15-minute lockout
    • Backend (api/app.py) must be running on port 5000


================================================================================
  PUBLIC PAGES — WHO CAN ACCESS
================================================================================

| Page                    | Access           |
|-------------------------|------------------|
| landpage.html           | Everyone         |
| current-prices.html     | Everyone         |
| forecast.html           | Everyone         |
| historical.html         | Logged-in users  |
| statistics.html         | Logged-in users  |
| login.html / signup.html| Everyone         |


================================================================================
  SETUP (QUICK)
================================================================================

1. Install Python packages:
     cd C:\xampp\htdocs\AgriPricePH
     py -3.13 -m pip install -r requirements.txt
     py -3.13 -m pip install tensorflow==2.20.0

2. Database (first time + 2026 data):
     cd datasets
     py -3.13 script.py
     py -3.13 import_2026.py

3. Create database (first time only):
     Double-click:  setup_database.bat
     Or manually:   cd datasets  →  py -3.13 script.py  →  py -3.13 import_2026.py

4. Start backend (keep terminal open):
     Double-click:  run_backend.bat
     Or manually:   cd api  →  py -3.13 app.py
     WRONG:         py app.py   (from project root — file not found!)
     RIGHT:         cd api first, then py -3.13 app.py
     Test: http://127.0.0.1:5000/api/health

5. Open frontend:
     Public:  public/landpage.html  (Live Server or XAMPP)
     Admin:   same as Public — click "Log in" and sign in with your admin account


================================================================================
  GMAIL SMTP SETUP (PASSWORD RESET EMAILS)
================================================================================

  Public/vendor accounts (public/signup.html) are real, server-side accounts now
  (SQLite: model/agriprice_users.db) — not just browser localStorage — so "Forgot
  password?" on the login page can email a real 6-digit reset code, sent from
  agripriceph@gmail.com via Gmail SMTP.

  One-time setup:
    1. Turn on 2-Step Verification on the agripriceph@gmail.com account
       (Google Account -> Security -> 2-Step Verification).
    2. Once that's on, go to Google Account -> Security -> App Passwords,
       generate one for "Mail", and copy the 16-character value it gives you.
       (This is NOT the regular Gmail password — don't use that one.)
    3. Copy .env.example to a new file named .env in the project root, and
       paste the App Password in as AGRIPRICE_GMAIL_APP_PASSWORD=...
       (.env is gitignored — never commit it.)
    4. py -3.13 -m pip install -r requirements.txt   (picks up python-dotenv)
    5. Restart the backend (run_backend.bat).

  Without this set up, signup/login/settings still work normally — only
  "Forgot password?" is affected (it returns a clear "email service is not
  configured" error instead of silently doing nothing).

  Troubleshooting:
    • SMTPAuthenticationError          -> you used the real Gmail password
                                           instead of the App Password, or
                                           2-Step Verification isn't on yet.
    • Connection refused / timed out   -> confirm port 465 (SSL), not 587
                                           (STARTTLS); a firewall may be
                                           blocking outbound 465.
    • "Less secure app access" advice  -> outdated; Google removed that
                                           option — App Passwords replaced it.


================================================================================
  TRAIN MODEL & PREDICTIONS
================================================================================

  Admin → Training → Start Training
  Or:  cd model  →  py -3.13 train.py

  Public → forecast.html  |  Admin → Predictions module
  Forecast API returns forecasts_by_key for all 8 rice types.


================================================================================
  API ENDPOINTS
================================================================================

| Method | Endpoint                   | Gamit                           |
|--------|-----------------------------|----------------------------------|
| GET    | /api/health                 | Server check                    |
| GET    | /api/historical-data        | Price charts                    |
| GET    | /api/predictions            | 2-day forecast (8 types)        |
| POST   | /api/run-training           | Start training                  |
| POST   | /api/admin/verify           | Admin login → token             |
| GET    | /api/admin/session          | Validate token                  |
| POST   | /api/admin/logout           | End admin session                |
| GET    | /api/settings               | System settings                  |
| PUT    | /api/settings               | Save settings                    |
| POST   | /api/auth/signup            | Create vendor account            |
| POST   | /api/auth/login              | Vendor login                    |
| POST   | /api/auth/forgot-password   | Email a reset code               |
| POST   | /api/auth/reset-password    | Verify code + set new password  |
| PUT    | /api/auth/profile           | Update name/email                |
| POST   | /api/auth/change-password   | Change password (logged in)     |


================================================================================
  8 RICE TYPES
================================================================================

  Imported: Special, Premium, Well-Milled, Regular
  Local:    Special, Premium, Well-Milled, Regular

  Keys: impSpecial, impPremium, impWellMilled, impRegular,
        locSpecial, locPremium, locWellMilled, locRegular


================================================================================
  TROUBLESHOOTING
================================================================================

  "can't open file app.py" / No such file or directory
    → app.py is inside the api\ folder, NOT the project root.
    → Use run_backend.bat  OR  cd api  then  py -3.13 app.py

  Blank charts / "Cannot reach backend"
    → Run run_backend.bat and keep the window open
    → Test http://127.0.0.1:5000/api/health in the browser

  Database empty or missing
    → Run setup_database.bat once
    → Backend also auto-imports 2026 data on startup (may take ~20 sec)

  Port 5000 already in use
    → Close other terminals running app.py
    → Or: py -3.13 app.py --serve --port 5001  (then update API URL in settings)

  Admin cannot sign in
    → Backend must run on port 5000
    → Sign in from the public site's "Log in" button (public/landpage.html) — there is no
      separate admin/login.html page anymore

  Styles or scripts missing after move
    → Use paths under public/ and admin/ as in this README
    → Hard refresh: Ctrl+F5

  Vendor account lost
    → Demo accounts are in browser localStorage only

================================================================================

For full architecture and ML details, see SYSTEM_GUIDE.txt

================================================================================

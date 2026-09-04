@echo off
title AgriPricePH Backend
cd /d "%~dp0"

REM Optional first argument = URL to open once the server is ready.
REM Example: run_backend.bat http://127.0.0.1:5000/public/landpage.html
if not "%~1"=="" (
  set "OPEN_URL=%~1"
) else if not "%OPEN_URL%"=="" (
  REM keep env override
) else (
  set "OPEN_URL=http://127.0.0.1:5000/public/login.html"
)

echo.
echo ========================================
echo   AgriPricePH - Start Backend (API)
echo ========================================
echo.

REM --- Find Python ---
set PY=
where py >nul 2>&1 && py -3.13 -c "import flask" >nul 2>&1 && set PY=py -3.13
if not defined PY where python >nul 2>&1 && python -c "import flask" >nul 2>&1 && set PY=python
if not defined PY (
  echo [ERROR] Python 3 with Flask not found.
  echo.
  echo Fix: From this folder run:
  echo   py -3.13 -m pip install -r requirements.txt
  echo.
  pause
  exit /b 1
)

echo Using: %PY%
echo.

REM --- Must run from api folder ---
if not exist "api\app.py" (
  echo [ERROR] api\app.py not found. Run this file from the AgriPricePH project folder.
  pause
  exit /b 1
)

REM --- If backend is already up, just open the browser ---
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:5000/api/health' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if %errorlevel%==0 (
  echo Backend is already running on port 5000.
  echo Opening %OPEN_URL%
  start "" "%OPEN_URL%"
  echo.
  echo You can use the app now. Close this window if you did not start the server here.
  pause
  exit /b 0
)

cd api

echo Starting server... (first start may take 10-30 seconds)
echo.
echo   Public site:  http://127.0.0.1:5000/public/landpage.html
echo   Login page:   http://127.0.0.1:5000/public/login.html  (admin username here also works, then enter the 6-digit code)
echo   Health check: http://127.0.0.1:5000/api/health
echo.
echo The browser will open automatically when the server is ready.
echo Keep this window OPEN while using the app.
echo Press Ctrl+C to stop the server.
echo.

REM Wait for /api/health, then open the browser (runs in parallel with app.py below).
start "AgriPricePH Browser" /MIN cmd /c "powershell -NoProfile -Command "$url='%OPEN_URL%'; while ($true) { try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:5000/api/health' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { Start-Process $url; exit 0 } } catch { Start-Sleep -Seconds 2 } }""

%PY% app.py
if errorlevel 1 (
  echo.
  echo [ERROR] Backend stopped or failed to start.
  echo Common fixes:
  echo   1. Install packages: py -3.13 -m pip install -r requirements.txt
  echo   2. Port 5000 busy: close other app.py windows or restart PC
  echo   3. Run setup_db.bat if database is missing
  echo.
  pause
  exit /b 1
)

pause

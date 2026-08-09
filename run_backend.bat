@echo off
title AgriPricePH Backend
cd /d "%~dp0"

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

cd api

echo Starting server... (first start may take 10-30 seconds)
echo.
echo   Public site:  http://127.0.0.1:5000/public/landpage.html
echo   Admin login:  http://127.0.0.1:5000/admin/login.html
echo   Health check: http://127.0.0.1:5000/api/health
echo.
echo Keep this window OPEN while using the app.
echo Press Ctrl+C to stop the server.
echo.

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

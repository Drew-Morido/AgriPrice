@echo off
title AgriPricePH - Setup Database
cd /d "%~dp0"

echo.
echo ========================================
echo   AgriPricePH - Create / Update Database
echo ========================================
echo.

set PY=
where py >nul 2>&1 && set PY=py -3.13
if not defined PY set PY=python

echo Step 1: Build database tables (first time only)...
cd datasets
%PY% script.py
if errorlevel 1 (
  echo [ERROR] script.py failed.
  cd ..
  pause
  exit /b 1
)

echo.
echo Step 2: Import 2026 daily data...
%PY% import_2026.py
cd ..

echo.
echo Done. Database should be at:
echo   datasets\agriprice_database.db
echo.
echo Next: double-click run_backend.bat to start the API server.
echo.
pause

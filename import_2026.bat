@echo off
cd /d "%~dp0"
echo AgriPricePH - Importing 2026 XLSX to database...
py -3.13 datasets\import_2026.py
if errorlevel 1 python datasets\import_2026.py
pause

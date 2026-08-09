@echo off
title AgriPricePH Database Browser Viewer
cd /d "%~dp0"

echo Sinisimulan ang Database Viewer...
:: Bubuksan nito ang browser pagkalipas ng 2 segundo
timeout /t 2 /nobreak > nul
start "" "http://127.0.0.1:5001"

:: Patatakbuhin ang Python script
python db_viewer.py

pause
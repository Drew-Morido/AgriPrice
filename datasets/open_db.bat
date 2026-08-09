@echo off
title AgriPricePH Database CLI
:: Lilipat tayo sa folder kung nasaan ang batch file
cd /d "%~dp0"

:: I-check kung nandiyan ang database file
if exist agriprice_database.db (
    echo --- AgriPricePH Database SQL Terminal ---
    echo Type .exit to close the terminal.
    echo.
    sqlite3 agriprice_database.db
) else (
    echo [!] Error: Hindi mahanap ang agriprice_database.db sa folder na ito.
    echo Siguraduhing nasa loob ito ng 'datasets' folder.
    pause
)
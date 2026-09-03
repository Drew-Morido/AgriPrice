@echo off
REM One-click launcher — starts the Flask backend and opens the public site with the login
REM modal ready (admin sign-in now goes through the same unified login as retailer accounts).
cd /d "%~dp0"
call "%~dp0run_backend.bat" "http://127.0.0.1:5000/public/landpage.html?auth=login"

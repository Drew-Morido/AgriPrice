@echo off
REM One-click launcher — starts the Flask backend and opens the admin login page.
cd /d "%~dp0"
call "%~dp0run_backend.bat" "http://127.0.0.1:5000/admin/login.html"

@echo off
REM One-click launcher — starts the Flask backend and opens the login page directly
REM (admin sign-in now also goes through this same page — enter your admin username
REM  instead of an email and you'll be prompted for the 6-digit access code).
cd /d "%~dp0"
call "%~dp0run_backend.bat" "http://127.0.0.1:5000/public/login.html"

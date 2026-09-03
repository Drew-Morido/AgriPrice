@echo off
title AgriPricePH - Install auto-start
cd /d "%~dp0"

echo.
echo ========================================
echo   AgriPricePH - Start on Windows login
echo ========================================
echo.
echo This adds a shortcut to your Windows Startup folder so the backend
echo starts automatically when you sign in to Windows.
echo.
echo You still need to keep the backend window open (or minimized).
echo The admin login page will open in your browser after the server is ready.
echo.
set /p CONFIRM=Install auto-start? (Y/N): 
if /I not "%CONFIRM%"=="Y" (
  echo Cancelled.
  pause
  exit /b 0
)

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LINK=%STARTUP%\AgriPricePH Backend.lnk"

powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell; ^
   $s = $ws.CreateShortcut('%LINK%'); ^
   $s.TargetPath = '%CD%\start_agriprice.bat'; ^
   $s.WorkingDirectory = '%CD%'; ^
   $s.WindowStyle = 1; ^
   $s.Description = 'Start AgriPricePH backend and open admin login'; ^
   $s.Save()"

if exist "%LINK%" (
  echo.
  echo [OK] Shortcut created:
  echo   %LINK%
  echo.
  echo To remove later: delete that shortcut from Startup, or run uninstall_autostart.bat
) else (
  echo [ERROR] Could not create startup shortcut.
)

echo.
pause

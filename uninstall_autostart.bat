@echo off
title AgriPricePH - Remove auto-start
set "LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AgriPricePH Backend.lnk"
if exist "%LINK%" (
  del "%LINK%"
  echo Removed auto-start shortcut.
) else (
  echo No AgriPricePH auto-start shortcut found.
)
pause

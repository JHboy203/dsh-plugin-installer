@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title DSH plugin-installer - collect diagnostics
echo.
echo  ============================================
echo   DSH plugin installer - collect diagnostics
echo   (read-only: no settings change, no network)
echo  ============================================
echo.
if not exist "%~dp0collect-diagnostics.ps1" (
  echo  [X] collect-diagnostics.ps1 is missing next to this .cmd
  echo      Please unzip the whole folder again.
  pause
  exit /b 2
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0collect-diagnostics.ps1"
set RC=%ERRORLEVEL%
if not "%RC%"=="0" (
  echo.
  echo  [X] collector exited with code %RC%
  echo      Send this window's text to the author together with the log file.
  pause
)
exit /b %RC%

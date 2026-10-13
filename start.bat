@echo off
REM ===========================================================
REM  Spectrum CPR booking - double-click to start
REM ===========================================================
setlocal enabledelayedexpansion
title Spectrum CPR booking
cd /d "%~dp0"

echo.
echo   Spectrum CPR + First Aid - booking system
echo   ========================================
echo.

REM --- Node present? ---------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo   Node.js is not installed.
  echo.
  echo   Download the LTS version from https://nodejs.org
  echo   then run this again.
  echo.
  pause
  exit /b 1
)

REM --- port already in use? --------------------------------
netstat -ano | findstr /r /c:"LISTENING.*:3000 " >nul 2>&1
if not errorlevel 1 (
  echo   Something is already listening on port 3000.
  echo   That is probably an older copy of this server still running.
  echo.
  echo   Close the other window, or run:  npx kill-port 3000
  echo.
  pause
  exit /b 1
)

REM --- dependencies ----------------------------------------
if not exist "node_modules" (
  echo   First run - installing dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   Install failed. See the messages above.
    pause
    exit /b 1
  )
  echo.
)

REM --- sample classes on a fresh database ------------------
if not exist "data\booking.db" (
  echo   Setting up the database...
  call npm run seed
  echo.
)

REM --- admin token -----------------------------------------
REM Written once to admin-token.txt so the admin page has a
REM password of its own. Delete that file to get a new one.
REM
REM Delayed expansion (!VAR!) matters here: plain %VAR% inside
REM a parenthesised block is expanded when the block is parsed,
REM which is before the token has been generated.
if not exist "admin-token.txt" (
  for /f %%i in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString(''N'').Substring(0,20)"') do set "NEWTOK=%%i"
  >admin-token.txt echo(!NEWTOK!
  echo   Created an admin token - saved in admin-token.txt
  echo.
)

set /p ADMIN_TOKEN=<admin-token.txt
REM Strip any stray spaces the file may have picked up.
for /f "tokens=* delims= " %%a in ("!ADMIN_TOKEN!") do set "ADMIN_TOKEN=%%a"

if "!ADMIN_TOKEN!"=="" (
  echo   admin-token.txt is empty. Delete it and run this again.
  echo.
  pause
  exit /b 1
)

echo   Booking page:  http://localhost:3000
echo   Admin page:    http://localhost:3000/admin.html
echo.
echo   Admin token:   !ADMIN_TOKEN!
echo.
echo   Leave this window open. Close it to stop.
echo.

start "" /b cmd /c "timeout /t 2 >nul && start http://localhost:3000"

call npm start

echo.
echo   Server stopped.
pause

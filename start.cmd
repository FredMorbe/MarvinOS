@echo off
rem Starts the macii hub and opens the UI. If the hub already runs on the port, only the browser opens.
cd /d "%~dp0"
if not defined AIOS_PORT set AIOS_PORT=4747
set URL=http://127.0.0.1:%AIOS_PORT%

netstat -ano | findstr /R /C:":%AIOS_PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo macii already runs on %URL%
  start "" "%URL%"
  exit /b 0
)

title macii hub
echo Starting macii on %URL% - close this window or press Ctrl+C to stop.
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start "" "%URL%""
call npm start
pause

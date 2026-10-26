@echo off
rem Starts AIOS as a desktop app (Electron). It starts the hub itself, or attaches to one that already runs on the port.
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron is missing. Run "npm install" and "node node_modules\electron\install.js" in %~dp0
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .

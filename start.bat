@echo off
REM Start the Moss harness: kill any stale Electron, build, then launch.
cd /d "%~dp0"
taskkill /IM electron.exe /F >nul 2>&1
call npm run build || exit /b 1
call npm start

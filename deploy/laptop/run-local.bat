@echo off
REM Windows: double-click or run from a terminal. Needs Node.js 22.18+ from https://nodejs.org
cd /d "%~dp0\..\.."
where node >nul 2>nul || (echo Install Node.js 22 first: https://nodejs.org & pause & exit /b 1)
node scripts\gen-env.ts
for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
  echo %%a| findstr /b "#" >nul || set "%%a=%%b"
)
node --disable-warning=ExperimentalWarning src\server\main.ts
pause

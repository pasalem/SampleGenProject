@echo off
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==0 (
  node server.js
  goto :eof
)
where python >nul 2>nul
if %errorlevel%==0 (
  echo Node.js not found - falling back to Python.
  start "" http://localhost:8080
  python -m http.server 8080 --bind 127.0.0.1 --directory public
  goto :eof
)
echo Neither Node.js nor Python was found on your PATH.
echo Install Node.js from https://nodejs.org and run this file again.
pause

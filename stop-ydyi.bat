@echo off
rem Stops the ydyi service (whatever listens on port 8000). (ASCII only)
cd /d %~dp0
node tools\stop-server.mjs 8000
echo.
pause

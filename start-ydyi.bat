@echo off
rem ydyi launcher: the server runs in THIS window.
rem Closing this window (or Ctrl+C) stops the service. (Keep this file ASCII-only.)
cd /d %~dp0
title ydyi-server - close this window to stop the service
node server.mjs
echo.
echo Server stopped.
pause

@echo off
rem Double-click to run all fetches (Windows counterpart of the .command launcher).
chcp 65001 >nul
cd /d "%~dp0"
node fetch-all.mjs
echo.
pause

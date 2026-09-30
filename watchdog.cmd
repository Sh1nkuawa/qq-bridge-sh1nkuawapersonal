@echo off
rem qq-bridge external watchdog launcher.
rem
rem What it does: probes the bridge console (http://127.0.0.1:3100/api/status). If the bridge
rem stops answering (a hung event loop cannot answer, and in-process timers hang with it), it
rem records evidence, kills the stuck process, and lets start.bat - or itself - bring it back.
rem Logs: state\watchdog.log ; incident evidence: state\watchdog-incident-*.json
rem Pause it (log only, never act): create an empty file state\watchdog.pause
rem
rem IMPORTANT: start this from a normal window / the desktop launcher / Task Scheduler.
rem Do NOT start it from inside a DSH session: DSH tears down its child processes on exit
rem (2026-09-29 lesson, see INSTALL_NOTES 16.3).
cd /d "%~dp0"
set "NODE=D:\nodejs16\node.exe"
if not exist "%NODE%" set "NODE=node"
title qq-bridge watchdog
echo [watchdog] starting... log: %~dp0state\watchdog.log
"%NODE%" "%~dp0scripts\watchdog-bridge.mjs" %*
set "CODE=%errorlevel%"
if "%CODE%"=="0" exit /b 0
echo.
echo [watchdog] exited with code %CODE%. Keep the output above as evidence, then press any key.
pause >nul
exit /b %CODE%

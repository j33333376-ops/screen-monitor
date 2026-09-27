@echo off
chcp 65001 >nul
title Student Screen Monitor Server
cd /d "%~dp0"

rem === Teacher password (change if you want) ===
set TEACHER_PASSWORD=teacher1234

rem === Screen save settings ===
rem Default save state at class start (on/off). Can be toggled on the teacher screen.
set SAVE_CAPTURES=on
rem Default save interval in seconds. The teacher screen offers 10 / 20 / 30 and
rem keeps this value as an extra choice when it is not one of them.
set SAVE_INTERVAL_SEC=30
rem To change save folder, uncomment and set path (default: Documents\screen-monitor\captures)
rem set SAVE_DIR=D:\student-screens

rem === Choose Node runtime ===
rem Prefer the bundled node.exe in this folder (no install needed). Otherwise use system Node.
set "NODE=node"
if exist "%~dp0node.exe" set "NODE=%~dp0node.exe"

rem Check availability
"%NODE%" --version >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node runtime not found.
  echo Put node.exe in this folder, or install Node.js LTS from https://nodejs.org
  pause
  exit /b 1
)

rem Never kill another process or an active class to free this port.
rem The server reports a readable error when the port is already in use.

rem === Open teacher screen in browser after 3 seconds ===
start "" /min cmd /c "timeout /t 3 >nul & start http://localhost:8080"

echo Starting server...  Teacher screen: http://localhost:8080
echo (End the class in the teacher screen before closing this window.)
echo.
"%NODE%" server.js

echo.
echo Server stopped.
pause

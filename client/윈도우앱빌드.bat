@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-exe.ps1"
if errorlevel 1 (
  echo Build failed. See the error above.
) else (
  echo EXE: dist folder
)
pause

@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage-waybills.ps1" -Interactive
echo.
pause

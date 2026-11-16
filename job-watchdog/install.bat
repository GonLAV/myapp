@echo off
rem Install the job watchdog (no admin needed).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
pause

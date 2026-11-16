@echo off
rem Remove the job-watchdog scheduled task. Settings and logs stay in %USERPROFILE%\job-watchdog
schtasks /delete /tn job-watchdog /f
pause

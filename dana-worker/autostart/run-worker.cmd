@echo off
rem Thin shim kept for people who start the worker by hand: the logic is in run-worker.ps1 (restart after a crash,
rem no restart after a deliberate stop, one instance, log in work_root\worker.log).
rem   run-worker.cmd [path-to-worker-config.json]
if "%~1"=="" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-worker.ps1"
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-worker.ps1" -Config "%~1"
)
exit /b %ERRORLEVEL%

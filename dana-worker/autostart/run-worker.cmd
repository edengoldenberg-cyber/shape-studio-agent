@echo off
rem Started by the DanaEditingWorker scheduled task (see install.ps1). Logs to work_root\worker.log.
setlocal
set "HERE=%~dp0.."
set "PY=C:\Users\owner\AppData\Local\Programs\Python\Python310\python.exe"
if not exist "%PY%" (echo Python 3.10 not found at %PY% & exit /b 1)
if not exist "C:\Users\owner\dana-work" mkdir "C:\Users\owner\dana-work"
"%PY%" -X utf8 "%HERE%\worker.py" --config "%HERE%\worker.config.json" >> "C:\Users\owner\dana-work\worker.log" 2>&1
exit /b %ERRORLEVEL%

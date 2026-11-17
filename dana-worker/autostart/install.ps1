# Dana worker auto-start. Approved by the owner on 2026-11-17 (start at Windows logon, no duplicate processes,
# recovery after a crash, availability shown by the server). Run it once; it changes nothing else on the machine.
#
# What it does
#   Registers ONE Windows Scheduled Task, "DanaEditingWorker", for the CURRENT user:
#     - trigger: at logon of this user (no admin rights, no service, nothing runs when logged out)
#     - action:  run-worker.ps1, hidden, with the PRODUCTION configuration
#                (C:\Users\owner\dana-work\worker.config.production.json when it exists; -Config overrides)
#     - one instance: the task never starts a second copy (IgnoreNew), and the worker itself holds an OS lock on
#       <work_root>\worker.lock, so a worker started by hand and the task cannot run together
#     - recovery: run-worker.ps1 restarts the worker after a crash; if the wrapper itself fails, the task is
#       restarted up to 3 times, 1 minute apart
#     - a deliberate stop is respected: a STOP file in work_root ends the worker and nothing restarts it
#   It does not store the worker token. The token must already be in the USER environment variable named by
#   "token_env" in the configuration (default DANA_WORKER_TOKEN).
#   It does not change Windows power settings. (While a job or a voice message is being processed the worker asks
#   Windows not to sleep; an idle machine still sleeps, and the server then shows the worker as offline.)
#
# Stop / disable
#   dana-worker\autostart\stop.ps1 [-Hold]   stop the running worker (the task stays; -Hold keeps it stopped)
#   dana-worker\autostart\uninstall.ps1      remove the task completely
#
# Usage:  powershell -ExecutionPolicy Bypass -File install.ps1 [-Config <json>] [-WhatIf] [-StartNow]
param([string]$Config, [switch]$WhatIf, [switch]$StartNow)
$ErrorActionPreference = 'Stop'
$dir  = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'common.ps1')
$run  = Join-Path $PSScriptRoot 'run-worker.ps1'
$cfg  = Resolve-WorkerConfig $Config $dir
$name = 'DanaEditingWorker'

$conf = Get-Content $cfg -Raw -Encoding UTF8 | ConvertFrom-Json
$tokenVar = if ($conf.token_env) { $conf.token_env } else { 'DANA_WORKER_TOKEN' }
if (-not [Environment]::GetEnvironmentVariable($tokenVar, 'User')) {
  throw "User environment variable $tokenVar is not set. Set it first (the value is never written to a file by this script)."
}

$action   = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $dir `
            -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$run`" -Config `"$cfg`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
            -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Write-Host "Task:      $name (current user: $env:USERNAME, at logon, hidden, not elevated, one instance)"
Write-Host "Runs:      $run"
Write-Host "Config:    $cfg"
Write-Host "Server:    $($conf.server_url)"
Write-Host "Work root: $($conf.paths.work_root)  (log: worker.log, stop: STOP file, lock: worker.lock)"
Write-Host "Token var: $tokenVar (user environment; value not shown)"
if ($WhatIf) { Write-Host 'WhatIf: nothing was registered.'; exit 0 }
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Dana local editing worker and voice-message transcription (polls the server outbound; one job at a time).' -Force | Out-Null
Write-Host "Registered. It starts at the next logon."
if ($StartNow) { Start-ScheduledTask -TaskName $name; Write-Host 'Started now.' }
else { Write-Host "Start now with:  Start-ScheduledTask -TaskName $name   (a worker that is already running keeps the lock; the new one then exits)" }

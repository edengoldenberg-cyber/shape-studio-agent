# Dana worker auto-start (OPTIONAL). NOT installed by default.
# Run this only after the owner approved the exact setup below.
#
# What it does
#   Registers ONE Windows Scheduled Task, "DanaEditingWorker", for the CURRENT user:
#     - trigger: at logon of this user (no admin rights, no service, nothing runs when logged out)
#     - action:  run-worker.cmd (minimised), which starts worker.py with worker.config.json
#     - restart: up to 3 times, 1 minute apart, if the worker exits with an error
#   It does not store the worker token. The token must already be in the USER environment
#   variable named by "token_env" in worker.config.json (default DANA_WORKER_TOKEN).
#
# Stop / disable
#   dana-worker\autostart\stop.ps1        stop the running worker now (the task stays)
#   dana-worker\autostart\uninstall.ps1   remove the task completely
#   Or create an empty file named STOP in the worker's work_root: the worker exits at its
#   next poll and will not take jobs again until the file is deleted.
#
# Usage:  powershell -ExecutionPolicy Bypass -File install.ps1 [-WhatIf]
param([switch]$WhatIf)
$ErrorActionPreference = 'Stop'
$dir   = Split-Path -Parent $PSScriptRoot
$cmd   = Join-Path $PSScriptRoot 'run-worker.cmd'
$cfg   = Join-Path $dir 'worker.config.json'
$name  = 'DanaEditingWorker'

if (-not (Test-Path $cfg)) { throw "worker.config.json not found in $dir" }
$conf = Get-Content $cfg -Raw -Encoding UTF8 | ConvertFrom-Json
$tokenVar = if ($conf.token_env) { $conf.token_env } else { 'DANA_WORKER_TOKEN' }
if (-not [Environment]::GetEnvironmentVariable($tokenVar, 'User')) {
  throw "User environment variable $tokenVar is not set. Set it first (the value is never written to a file by this script)."
}

$action   = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c start `"Dana worker`" /min `"$cmd`"" -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
            -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Write-Host "Task:      $name (current user: $env:USERNAME, at logon, not elevated)"
Write-Host "Runs:      $cmd"
Write-Host "Server:    $($conf.server_url)"
Write-Host "Token var: $tokenVar (user environment; value not shown)"
if ($WhatIf) { Write-Host 'WhatIf: nothing was registered.'; exit 0 }
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Dana local editing worker (polls the Dana server outbound; edits one job at a time).' -Force | Out-Null
Write-Host "Registered. It starts at the next logon. Start now with:  Start-ScheduledTask -TaskName $name"

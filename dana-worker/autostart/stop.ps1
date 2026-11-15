# Stop the Dana worker now. The scheduled task (if installed) stays and will start again at the
# next logon; use uninstall.ps1 to remove it, or -Hold to keep the worker stopped.
#   powershell -ExecutionPolicy Bypass -File stop.ps1 [-Hold]
param([switch]$Hold)
$dir  = Split-Path -Parent $PSScriptRoot
$conf = Get-Content (Join-Path $dir 'worker.config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$stop = Join-Path $conf.paths.work_root 'STOP'
New-Item -ItemType File -Path $stop -Force | Out-Null          # the worker exits at its next poll
Write-Host "STOP file created: $stop"
try { Stop-ScheduledTask -TaskName 'DanaEditingWorker' -ErrorAction Stop; Write-Host 'Scheduled task stopped.' } catch { Write-Host 'No running scheduled task.' }
if (-not $Hold) {
  Start-Sleep -Seconds 12
  Remove-Item $stop -Force -ErrorAction SilentlyContinue
  Write-Host 'STOP file removed (the worker may be started again). Use -Hold to keep it stopped.'
} else { Write-Host 'Worker is held. Delete the STOP file to allow it to run again.' }

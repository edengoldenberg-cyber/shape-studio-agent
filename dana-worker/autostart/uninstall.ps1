# Remove the Dana worker auto-start completely. A worker that is running now is asked to stop first (STOP file),
# so no job is cut in the middle; the STOP file is removed again when the worker has ended.
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-Config <json>]
param([string]$Config)
& (Join-Path $PSScriptRoot 'stop.ps1') -Config $Config
try { Unregister-ScheduledTask -TaskName 'DanaEditingWorker' -Confirm:$false -ErrorAction Stop; Write-Host 'Scheduled task removed.' }
catch { Write-Host 'The scheduled task was not installed.' }

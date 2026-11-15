# Remove the Dana worker auto-start completely.
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
try { Stop-ScheduledTask -TaskName 'DanaEditingWorker' -ErrorAction Stop } catch { }
try { Unregister-ScheduledTask -TaskName 'DanaEditingWorker' -Confirm:$false -ErrorAction Stop; Write-Host 'Scheduled task removed.' }
catch { Write-Host 'The scheduled task was not installed.' }

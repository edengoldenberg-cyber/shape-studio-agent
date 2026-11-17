# Stop the Dana worker. The scheduled task (if installed) stays and starts the worker again at the next logon;
# use uninstall.ps1 to remove it, or -Hold to keep the worker stopped (the STOP file stays until you delete it).
#   powershell -ExecutionPolicy Bypass -File stop.ps1 [-Config <json>] [-Hold] [-Force]
# The worker sees the STOP file at its next poll, i.e. after the job it is working on. -Force ends the task now
# (a job in progress is lost and returns to the queue on the server).
param([string]$Config, [switch]$Hold, [switch]$Force)
$dir  = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'common.ps1')
$conf = Get-Content (Resolve-WorkerConfig $Config $dir) -Raw -Encoding UTF8 | ConvertFrom-Json
$stop = Join-Path $conf.paths.work_root 'STOP'
$lock = Join-Path $conf.paths.work_root 'worker.lock'
New-Item -ItemType File -Path $stop -Force | Out-Null          # the worker exits at its next poll; the wrapper does not restart it
Write-Host "STOP file created: $stop"

function Test-WorkerRunning {                                  # the worker holds an OS lock on worker.lock while it lives
  if (-not (Test-Path $lock)) { return $false }
  try { $f = [IO.File]::Open($lock, 'Open', 'ReadWrite', 'None'); $f.Close(); return $false } catch { return $true }
}
$waited = 0
while ((Test-WorkerRunning) -and $waited -lt 20) { Start-Sleep -Seconds 2; $waited += 2 }
if (Test-WorkerRunning) {
  if ($Force) {
    try { Stop-ScheduledTask -TaskName 'DanaEditingWorker' -ErrorAction Stop; Write-Host 'Scheduled task ended now (-Force).' } catch { Write-Host 'No running scheduled task to end; a worker started by hand must be closed by hand.' }
  } else { Write-Host 'The worker is in the middle of a job; it stops when the job ends. Use -Force to end it now.'; $Hold = $true }
} else { Write-Host 'The worker is not running.' }
if (-not $Hold) {
  Remove-Item $stop -Force -ErrorAction SilentlyContinue
  Write-Host 'STOP file removed (the worker may be started again). Use -Hold to keep it stopped.'
} else { Write-Host "Worker is held. Delete $stop to allow it to run again." }

# Keeps ONE Dana worker running. Started hidden by the "DanaEditingWorker" scheduled task (install.ps1); can also be run by hand.
#
#   powershell -ExecutionPolicy Bypass -File run-worker.ps1 [-Config <worker config json>]
#
# - The worker exits 0 when it was stopped ON PURPOSE (a STOP file in work_root) or when another worker already holds
#   work_root: this script then ends too. A deliberate stop is never undone from here.
# - Any other exit (a crash, a refused start) is restarted after a pause that grows from 30 s to 5 min. Five failures in a
#   row that each lasted under a minute end the script with exit 1 (a broken configuration is not retried for ever; the
#   scheduled task then retries on its own schedule, and the server shows the worker as offline).
# - Output goes to <work_root>\worker.log. The token is read by the worker from the user environment; it is never written here.
# - Nothing in the Windows power settings is changed.
param([string]$Config)
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'common.ps1')
$cfgPath = Resolve-WorkerConfig $Config $dir
$conf    = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$root    = $conf.paths.work_root
$py      = if ($env:DANA_WORKER_PYTHON) { $env:DANA_WORKER_PYTHON } else { 'C:\Users\owner\AppData\Local\Programs\Python\Python310\python.exe' }
$script  = if ($env:DANA_WORKER_SCRIPT) { $env:DANA_WORKER_SCRIPT } else { Join-Path $dir 'worker.py' }   # override = tests only
if (-not (Test-Path $py)) { Write-Error "Python not found at $py"; exit 1 }
if (-not (Test-Path $root)) { New-Item -ItemType Directory -Force $root | Out-Null }
$log  = Join-Path $root 'worker.log'
$stop = Join-Path $root 'STOP'
function Note($m) { Add-Content -Path $log -Encoding utf8 -Value ("{0} [autostart] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) }

$quick = 0; $pause = 30
while ($true) {
  if (Test-Path $stop) { Note "STOP file present - not starting"; exit 0 }
  $t0 = Get-Date
  Note "starting the worker ($cfgPath)"
  # cmd does the redirection so the worker's UTF-8 output is appended byte for byte
  $p = Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -PassThru -Wait -WorkingDirectory $dir `
        -ArgumentList '/c', "`"`"$py`" -X utf8 `"$script`" --config `"$cfgPath`" >> `"$log`" 2>&1`""
  $code = $p.ExitCode
  $ran  = [int]((Get-Date) - $t0).TotalSeconds
  if ($code -eq 0) { Note "the worker ended on purpose (exit 0 after $ran s) - not restarting"; exit 0 }
  if (Test-Path $stop) { Note "the worker exited $code and a STOP file is present - not restarting"; exit 0 }
  if ($ran -lt 60) { $quick++ } else { $quick = 0; $pause = 30 }
  if ($quick -ge 5) { Note "the worker failed $quick times in a row within a minute of starting (last exit $code) - giving up"; exit 1 }
  Note "the worker exited $code after $ran s - restarting in $pause s"
  $waitS = if ($env:DANA_WORKER_RESTART_PAUSE_S) { [int]$env:DANA_WORKER_RESTART_PAUSE_S } else { $pause }
  Start-Sleep -Seconds $waitS
  $pause = [Math]::Min($pause * 2, 300)
}

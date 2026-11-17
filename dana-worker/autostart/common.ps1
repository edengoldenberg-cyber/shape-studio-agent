# Shared by install.ps1 / run-worker.ps1 / stop.ps1: which worker configuration is used.
#   -Config given        -> that file
#   otherwise            -> C:\Users\owner\dana-work\worker.config.production.json when it exists (the production worker),
#                           else worker.config.json beside worker.py
function Resolve-WorkerConfig([string]$Config, [string]$WorkerDir) {
  $prod = 'C:\Users\owner\dana-work\worker.config.production.json'
  $path = if ($Config) { $Config } elseif (Test-Path $prod) { $prod } else { Join-Path $WorkerDir 'worker.config.json' }
  if (-not (Test-Path $path)) { throw "worker configuration not found: $path" }
  return (Resolve-Path $path).Path
}

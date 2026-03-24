$scriptPath = Join-Path $PSScriptRoot "download-ranked.py"
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
  $python = Get-Command py -ErrorAction SilentlyContinue
}
if (-not $python) {
  throw "python was not found on PATH"
}
if ($python.Name -ieq "py.exe") {
  & $python.Source -3 $scriptPath @args
} else {
  & $python.Source $scriptPath @args
}
exit $LASTEXITCODE

$ErrorActionPreference = 'Stop'

$bundledPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$python = if ($env:PYTHON_EXE -and (Test-Path -LiteralPath $env:PYTHON_EXE)) {
  $env:PYTHON_EXE
} elseif (Test-Path -LiteralPath $bundledPython) {
  $bundledPython
} else {
  throw 'Python runtime not found. Set PYTHON_EXE to a valid python.exe path.'
}

& $python `
  'scripts\extract-ai-review-experiment.py' `
  '--teacher-dir' '..\..\essay collection' `
  '--model-dir' '..\..\essay collection2' `
  '--teacher-since' '2025-06-01' `
  '--output' 'data\ai-review-experiment\manifest.json'

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

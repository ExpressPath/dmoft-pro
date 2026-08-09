$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot

Push-Location (Join-Path $repositoryRoot "client")
try {
    python -m ruff check .
    python -m ruff format --check .
    python -m mypy src
    python -m pytest
}
finally {
    Pop-Location
}

Push-Location (Join-Path $repositoryRoot "billing")
try {
    npm.cmd run check
}
finally {
    Pop-Location
}

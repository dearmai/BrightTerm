param([switch]$Silent)

$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $projectDir 'package.json') -Raw | ConvertFrom-Json
$installer = Join-Path $projectDir "dist/BrightTerm-Setup-$($package.version).exe"
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "Installer not found: $installer. Run make build first."
}

$startOptions = @{
    FilePath = $installer
    Wait = $true
    PassThru = $true
}
if ($Silent) {
    $startOptions.ArgumentList = @('/S')
    $startOptions.WindowStyle = 'Hidden'
}
$process = Start-Process @startOptions
if ($process.ExitCode -ne 0) {
    throw "BrightTerm installer exited with code $($process.ExitCode)."
}

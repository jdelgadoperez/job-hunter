# Windows 11+ installer for job-hunter. Installs dependencies, then runs guided setup.
# Usage (PowerShell):  ./install.ps1
$ErrorActionPreference = "Stop"

Set-Location -Path $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is required but was not found. Install Node 24 (see .nvmrc) from https://nodejs.org and re-run."
    exit 1
}

# The CLI uses APIs that require Node 22+ (array-format util.styleText); .nvmrc pins 24.
$nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 22) {
    Write-Error "job-hunter needs Node 22 or newer (found $(node -v)). Install Node 24 (see .nvmrc) from https://nodejs.org and re-run."
    exit 1
}
if ($nodeMajor -lt 24) {
    Write-Host "Note: Node 24 is recommended (see .nvmrc) - you're on $(node -v). Continuing..."
}

Write-Host "Installing dependencies..."
npm install

Write-Host "Running setup..."
npm run setup

# Only prompt in an interactive session; a non-interactive run has no console to read from.
if ([Environment]::UserInteractive) {
    $reply = Read-Host "Keep the dashboard running in the background (start at logon)? [y/N]"
    if ($reply -match '^[yY]') {
        & "$PSScriptRoot\service-install.ps1"
    } else {
        Write-Host "Skipped. You can enable it later with ./service-install.ps1"
    }
} else {
    Write-Host "To keep the dashboard running in the background, run ./service-install.ps1"
}

# Windows 11+ installer for job-hunter. Installs dependencies, then runs guided setup.
# Usage (PowerShell):  ./install.ps1
$ErrorActionPreference = "Stop"

Set-Location -Path $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is required but was not found. Install Node 20+ from https://nodejs.org and re-run."
    exit 1
}

Write-Host "Installing dependencies..."
npm install

Write-Host "Running setup..."
npm run setup

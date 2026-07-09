# Windows 11+ installer for job-hunter. Installs dependencies, then runs guided setup.
# Usage (PowerShell):  ./install.ps1
$ErrorActionPreference = "Stop"

Set-Location -Path $PSScriptRoot

# The CLI uses APIs that require Node 22+ (array-format util.styleText); .nvmrc pins 24.
$NodeMinMajor = 22

# True when a usable Node is present and new enough.
function Test-NodeOk {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
    return [int](node -p 'process.versions.node.split(".")[0]') -ge $NodeMinMajor
}

# Install the latest Node LTS, preferring an already-installed fnm and otherwise winget.
# Returns $true only if Node is usable afterwards.
function Install-NodeLts {
    if (Get-Command fnm -ErrorAction SilentlyContinue) {
        Write-Host "Installing the latest Node LTS via fnm..."
        fnm install --lts
        # Make fnm's shims active in this session so `node` resolves below.
        fnm env | Out-String | Invoke-Expression
        fnm use lts-latest
        return (Test-NodeOk)
    }
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "Installing the latest Node LTS via winget..."
        winget install --id OpenJS.NodeJS.LTS -e --source winget `
            --accept-package-agreements --accept-source-agreements
        # Refresh PATH for this session so the freshly installed node is found without a restart.
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                    [System.Environment]::GetEnvironmentVariable("Path", "User")
        return (Test-NodeOk)
    }
    return $false
}

if (-not (Test-NodeOk)) {
    if (Get-Command node -ErrorAction SilentlyContinue) {
        Write-Host "job-hunter needs Node $NodeMinMajor or newer (found $(node -v))."
    } else {
        Write-Host "Node.js is required but was not found."
    }
    if (Install-NodeLts) {
        Write-Host "Using $(node -v)."
    } else {
        Write-Error "Couldn't set up a compatible Node automatically. Install Node 24 (see .nvmrc) from https://nodejs.org and re-run ./install.ps1"
        exit 1
    }
}

$nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 24) {
    Write-Host "Note: Node 24 is recommended (see .nvmrc) - you're on $(node -v). Continuing..."
}

Write-Host "Installing dependencies..."
npm install

Write-Host "Running setup..."
npm run setup

# Only prompt in an interactive session; a non-interactive run has no console to read from.
if ([Environment]::UserInteractive) {
    $reply = Read-Host "Add a 'job-hunter' command to your PATH (so you can skip 'npm run cli --')? [y/N]"
    if ($reply -match '^[yY]') {
        & "$PSScriptRoot\command-install.ps1"
    } else {
        Write-Host "Skipped. You can add it later with ./command-install.ps1"
    }

    $reply = Read-Host "Keep the dashboard running in the background (start at logon)? [y/N]"
    if ($reply -match '^[yY]') {
        & "$PSScriptRoot\service-install.ps1"
    } else {
        Write-Host "Skipped. You can enable it later with ./service-install.ps1"
    }
} else {
    Write-Host "To add a 'job-hunter' command to your PATH, run ./command-install.ps1"
    Write-Host "To keep the dashboard running in the background, run ./service-install.ps1"
}

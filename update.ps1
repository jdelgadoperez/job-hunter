# Update job-hunter to the latest version. Pulls the newest code, refreshes dependencies, and
# re-runs setup non-interactively (rebuilds the dashboard, refreshes the browser + skill dictionary;
# your saved settings, profile, and matches are preserved, and the database migrates on next start).
# Usage (PowerShell):  ./update.ps1
$ErrorActionPreference = "Stop"

Set-Location -Path $PSScriptRoot

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "git is required to update but was not found."
    exit 1
}

Write-Host "Pulling the latest version..."
git pull --ff-only

Write-Host "Refreshing dependencies..."
npm install

Write-Host "Re-running setup..."
npm run setup -- --yes

if (Get-ScheduledTask -TaskName "JobHunterDashboard" -ErrorAction SilentlyContinue) {
    Write-Host "Restarting the background service to pick up the update..."
    & "$PSScriptRoot\service-stop.ps1"
    & "$PSScriptRoot\service-start.ps1"
}
Write-Host "Update complete. If 'npm run serve' is running, restart it to pick up the changes."

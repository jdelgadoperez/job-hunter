# Remove the job-hunter dashboard background service (Windows). Usage: ./service-uninstall.ps1
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
. (Join-Path $PSScriptRoot "scripts\service\common.ps1")

if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Write-Host "Nothing to remove."
    exit 0
}
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Background service removed. (The dashboard is no longer running.)"

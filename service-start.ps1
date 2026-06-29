# Start the job-hunter dashboard service now (Windows). Usage: ./service-start.ps1
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
. (Join-Path $PSScriptRoot "scripts\service\common.ps1")
if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Write-Error "Not installed. Run ./service-install.ps1 first."
    exit 1
}
Start-ScheduledTask -TaskName $TaskName
Write-Host "Started. Open http://localhost:4317"

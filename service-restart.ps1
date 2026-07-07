# Restart the job-hunter dashboard service now (Windows). Usage: ./service-restart.ps1
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
. (Join-Path $PSScriptRoot "scripts\service\common.ps1")
if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Write-Error "Not installed. Run ./service-install.ps1 first."
    exit 1
}
# Delegate to the proven stop + start scripts rather than re-implementing the task control.
& (Join-Path $PSScriptRoot "service-stop.ps1")
& (Join-Path $PSScriptRoot "service-start.ps1")

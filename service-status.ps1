# Show whether the job-hunter dashboard service is running, plus recent log lines (Windows).
# Usage: ./service-status.ps1
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
. (Join-Path $PSScriptRoot "scripts\service\common.ps1")
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "Not installed."
    exit 0
}
if ($task.State -eq "Running") {
    Write-Host "Running. Dashboard at http://localhost:4317"
} else {
    Write-Host "Installed but not running. Run ./service-start.ps1"
}
$log = Get-LogFile
if (Test-Path $log) {
    Write-Host "--- recent log ($log) ---"
    Get-Content -Path $log -Tail 20
}

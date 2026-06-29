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
# A logon-triggered task returns to "Ready" once it has spawned its process, so $task.State is not a
# liveness signal for a long-running dashboard. Check whether something is actually listening on the
# port instead — the Windows analog of the macOS `launchctl print` liveness check.
$listening = Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    Write-Host "Running. Dashboard at http://localhost:4317"
} else {
    Write-Host "Installed but not running. Run ./service-start.ps1"
}
$log = Get-LogFile
if (Test-Path $log) {
    Write-Host "--- recent log ($log) ---"
    Get-Content -Path $log -Tail 20
}

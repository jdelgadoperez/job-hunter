# Install the job-hunter dashboard as a per-user background service (Windows).
# Starts at logon. No admin required. Usage (PowerShell): ./service-install.ps1
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
. (Join-Path $PSScriptRoot "scripts\service\common.ps1")

Assert-Node

$repo = Get-RepoDir
if (-not (Test-Path (Join-Path $repo "web\dist\index.html"))) {
    Write-Error "The dashboard isn't built yet. Run ./install.ps1 first, then re-run this."
    exit 1
}

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Error "Already installed. Run ./service-uninstall.ps1 first to reinstall."
    exit 1
}

$node = Get-NodeBin
$entry = Get-ServeEntry
$log = Get-LogFile
# Redirect the dashboard's output to the log file via cmd, since scheduled-task actions don't redirect.
$cmdArgs = "/c `"`"$node`" --import tsx `"$entry`" serve --no-open >> `"$log`" 2>&1`""
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $cmdArgs -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Dashboard will start automatically at logon. Open http://localhost:4317"

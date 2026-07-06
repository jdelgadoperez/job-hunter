# Remove the `job-hunter` command from your PATH (Windows). Usage: ./command-uninstall.ps1
# Removes the shim we wrote and drops ~\.local\bin from the user PATH if we added it.
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$binDir = Join-Path $env:USERPROFILE ".local\bin"
$shim = Join-Path $binDir "job-hunter.cmd"

if (-not (Test-Path $shim)) {
    Write-Host "Nothing to remove."
    exit 0
}

Remove-Item -Path $shim -Force
Write-Host "Removed: $shim"

# Drop ~\.local\bin from the user PATH only if it's now empty of anything we manage — leave it if the
# user has other tools there. We remove the entry only when the directory no longer exists or is empty.
if (-not (Test-Path $binDir) -or -not (Get-ChildItem -Path $binDir -Force)) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath) {
        $kept = ($userPath -split ";") | Where-Object { $_ -and $_ -ne $binDir }
        [Environment]::SetEnvironmentVariable("Path", ($kept -join ";"), "User")
        Write-Host "Removed $binDir from your user PATH."
    }
}
Write-Host "The 'job-hunter' command is gone; 'npm run cli -- ...' still works."

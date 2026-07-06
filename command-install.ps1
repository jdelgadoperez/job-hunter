# Put a `job-hunter` command on your PATH (Windows) so you can run `job-hunter <command>` from
# anywhere instead of `npm run cli -- <command>`. No admin required. Usage: ./command-install.ps1
#
# Writes a job-hunter.cmd shim into %USERPROFILE%\.local\bin (adding that dir to your user PATH if
# needed) that forwards to bin\job-hunter.ps1. Re-runnable.
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is required but was not found. Install Node 24 (see .nvmrc) from https://nodejs.org and re-run."
    exit 1
}

$repo = $PSScriptRoot
$wrapper = Join-Path $repo "bin\job-hunter.ps1"
if (-not (Test-Path $wrapper)) {
    Write-Error "Can't find bin\job-hunter.ps1 in $repo. Run ./install.ps1 first."
    exit 1
}

$binDir = Join-Path $env:USERPROFILE ".local\bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$shim = Join-Path $binDir "job-hunter.cmd"

# A .cmd shim is the most portable way to expose a command on Windows PATH without admin: it runs
# our PowerShell wrapper and forwards all args. %* passes them through verbatim.
$shimBody = "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$wrapper`" %*`r`n"
Set-Content -Path $shim -Value $shimBody -Encoding ASCII
Write-Host "Wrote command shim: $shim"

# Ensure ~\.local\bin is on the USER PATH (persists across sessions; no admin, no machine PATH).
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$onPath = ($userPath -split ";") -contains $binDir
if (-not $onPath) {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $binDir } else { "$userPath;$binDir" }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Host "Added $binDir to your user PATH. Open a NEW terminal, then run: job-hunter <command>"
} else {
    Write-Host "You can now run: job-hunter <command>   (e.g. job-hunter serve)"
}

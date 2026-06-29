# scripts/service/common.ps1
# Shared helpers for the job-hunter dashboard service scripts (Windows). Dot-sourced, not run.

$TaskName = "JobHunterDashboard"

function Assert-Node {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw "Node.js is required but was not found. Install Node 24 (see .nvmrc) from https://nodejs.org and re-run."
    }
    $major = [int](node -p 'process.versions.node.split(".")[0]')
    if ($major -lt 22) {
        throw "job-hunter needs Node 22 or newer (found $(node -v)). Install Node 24 (see .nvmrc) from https://nodejs.org and re-run."
    }
}

function Get-RepoDir {
    # This file lives at <repo>\scripts\service\common.ps1
    return (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}

function Get-DataDir {
    if ($env:JOB_HUNTER_HOME) { return $env:JOB_HUNTER_HOME }
    if ($env:APPDATA) { return (Join-Path $env:APPDATA "job-hunter") }
    return (Join-Path $env:USERPROFILE "job-hunter")
}

function Get-LogFile {
    $dir = Join-Path (Get-DataDir) "logs"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    return (Join-Path $dir "dashboard.log")
}

function Get-NodeBin { return (Get-Command node).Source }

function Get-ServeEntry { return (Join-Path (Get-RepoDir) "src\cli\main.ts") }

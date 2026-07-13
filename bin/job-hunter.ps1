# The `job-hunter` command (Windows). Invoked by the job-hunter.cmd shim that command-install.ps1
# places on your PATH, so you can run `job-hunter <command>` from anywhere instead of
# `npm run cli -- <command>`. Runs the TypeScript CLI through the tsx loader — the same way
# `npm run cli` does — so it always tracks the checked-out source (no build step).
$ErrorActionPreference = "Stop"

# This script lives at <repo>\bin\job-hunter.ps1; the repo is its parent's parent.
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

# Resolve tsx's loader from the repo's node_modules (a bare `tsx` specifier would be resolved against
# the user's current directory, which has no node_modules). Anchor resolution at the repo with
# createRequire so we don't change cwd — keeping the user's CWD means relative args like
# `job-hunter profile .\resume.pdf` still work. Emit a file:// URL: Node's --import requires a URL, and
# on Windows a bare absolute path like C:\...\loader.mjs is rejected because the drive letter reads as
# an unsupported URL scheme ('c:'). The repo path goes through an env var so we don't have to escape a
# Windows path (backslashes, spaces) into the JS string.
$env:JH_REPO = $repo
$tsxLoader = & node -e "const {createRequire}=require('module'),{pathToFileURL}=require('url'); const req=createRequire(pathToFileURL(process.env.JH_REPO + '/package.json')); process.stdout.write(pathToFileURL(req.resolve('tsx')).href)" 2>$null
if (-not $tsxLoader) {
    Write-Error "Couldn't find tsx in $repo. Run ./install.ps1 first."
    exit 1
}

# tsx locates the `@app/*` path aliases via tsconfig relative to the CWD by default — point it at the
# repo's tsconfig so the aliases resolve no matter where the command is run from.
$env:TSX_TSCONFIG_PATH = Join-Path $repo "tsconfig.json"

& node --import $tsxLoader (Join-Path $repo "src\cli\main.ts") @args
exit $LASTEXITCODE

# Background Dashboard Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let non-engineers on macOS and Windows run the `job-hunter serve` dashboard as a per-user background service that starts at login, via identical commands on both platforms.

**Architecture:** Mostly packaging — ten thin lifecycle scripts (`.sh` + `.ps1` pairs) drive each OS's native per-user scheduler (macOS LaunchAgent, Windows Task Scheduler at-logon). One application-code change: a pure, unit-tested helper that classifies a server listen error so `serve` logs a human message and exits non-zero on a port conflict, letting the OS restart it. The `update` scripts auto-restart the service when installed.

**Tech Stack:** TypeScript (strict, ESM) + vitest for the helper; Bash + PowerShell for the scripts; `launchctl` / `schtasks` as the OS mechanisms; `@hono/node-server` (returns a Node `http.Server` whose `'error'` event carries `EADDRINUSE`).

## Global Constraints

- **Node floor:** 22+ (24 recommended) — copy the exact version-guard wording from `install.sh` / `install.ps1`.
- **No new runtime dependencies** — scripts use only OS-builtin tools (`launchctl`, `schtasks`, `Register-ScheduledTask`).
- **TypeScript strict, ESM**, `target` ES2022, `@app/*` alias → `src/*`. No `!` non-null assertions. No type assertions outside tests.
- **Biome** for lint/format: 2-space indent, 100-col, double quotes. Run `npm run lint:fix` before committing TS.
- **Coverage gate:** statements 92 / branches 85 / functions 90 / lines 93. New TS keeps these green. `serve.ts` and the scripts are integration-bound and stay out of the gate; only the pure helper is covered.
- **Failures degrade, never crash** — at install/uninstall time fail loud (a human is watching); at runtime degrade and self-heal.
- **Commits:** Conventional Commits. Do NOT add a Claude co-authored footer.
- **Fixed port 4317**, loopback only. Predictable URL `http://localhost:4317`.
- **Data dir** (already implemented in `src/runtime/paths.ts`): `%APPDATA%\job-hunter` on Windows, `~/.job-hunter` on macOS; logs go in a `logs/` subdir of it.
- **Symmetry rule:** every command on macOS exists identically on Windows. The five verbs are `install / uninstall / start / stop / status`.

---

### Task 1: Pure listen-error classifier (the only app-code logic)

Extract the port-conflict decision into a pure, testable function. `serve.ts`
is excluded from the coverage gate (it binds ports / launches browsers), so the
logic lives in a new covered module and `serve.ts` only wires it.

**Files:**
- Create: `src/server/listen-error.ts`
- Test: `src/server/listen-error.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ListenErrorVerdict = { kind: "port-in-use"; message: string } | { kind: "other"; message: string }`
  - `classifyListenError(error: unknown, port: number): ListenErrorVerdict` — pure; maps a Node listen error to a human message and a kind. `EADDRINUSE` → `port-in-use`; anything else → `other`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/server/listen-error.test.ts
import { describe, expect, it } from "vitest";
import { classifyListenError } from "./listen-error";

const PORT = 4317;

describe("classifyListenError", () => {
  it("classifies EADDRINUSE as port-in-use with the port in the message", () => {
    const err = Object.assign(new Error("bind failed"), { code: "EADDRINUSE" });
    const verdict = classifyListenError(err, PORT);
    expect(verdict.kind).toBe("port-in-use");
    expect(verdict.message).toContain(String(PORT));
  });

  it("classifies an unknown error code as other, preserving the message", () => {
    const err = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const verdict = classifyListenError(err, PORT);
    expect(verdict.kind).toBe("other");
    expect(verdict.message).toContain("permission denied");
  });

  it("handles a non-Error value without throwing", () => {
    const verdict = classifyListenError("boom", PORT);
    expect(verdict.kind).toBe("other");
    expect(verdict.message.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/listen-error.test.ts`
Expected: FAIL — `Cannot find module './listen-error'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/server/listen-error.ts

/** Outcome of inspecting a server "listen" error: a port conflict vs anything else. */
export type ListenErrorVerdict =
  | { kind: "port-in-use"; message: string }
  | { kind: "other"; message: string };

function readErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Classify a Node server "listen" error. EADDRINUSE means another process holds the port — the
 * caller should log and exit non-zero so the OS scheduler restarts it (self-healing). Any other
 * error is surfaced verbatim for diagnosis.
 */
export function classifyListenError(error: unknown, port: number): ListenErrorVerdict {
  if (readErrorCode(error) === "EADDRINUSE") {
    return {
      kind: "port-in-use",
      message: `Port ${port} is already in use; the dashboard could not start. It will retry.`,
    };
  }
  return { kind: "other", message: `The dashboard failed to start: ${readErrorMessage(error)}` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/listen-error.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Lint + typecheck**

Run: `npm run lint:fix && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/listen-error.ts src/server/listen-error.test.ts
git commit -m "feat(server): classify listen errors for resilient startup"
```

---

### Task 2: Wire the classifier into `serve` (integration seam)

Attach an `error` handler to the server returned by `@hono/node-server`'s
`serve()`, route it through `classifyListenError`, and on `port-in-use` log the
message and exit non-zero so the OS scheduler restarts the process. `serve.ts`
stays out of the coverage gate; this task has no unit test (it's the excluded
integration wiring — covered by the manual matrix in Task 9).

**Files:**
- Modify: `src/server/serve.ts` (the `serve({ ... }, callback)` block, ~line 112)

**Interfaces:**
- Consumes: `classifyListenError` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Add the import**

At the top of `src/server/serve.ts`, with the other `./`-relative imports:

```typescript
import { classifyListenError } from "./listen-error";
```

- [ ] **Step 2: Capture the server and attach an error handler**

Replace the existing call:

```typescript
  serve({ fetch: app.fetch, port, hostname: LOOPBACK_HOST }, (info) => {
    const url = `http://localhost:${info.port}`;
    console.log(`job-hunter dashboard running at ${url}`);
    console.log("Press Ctrl+C to stop.");
    if (opts.open !== false) openBrowser(url);
  });
```

with:

```typescript
  const server = serve({ fetch: app.fetch, port, hostname: LOOPBACK_HOST }, (info) => {
    const url = `http://localhost:${info.port}`;
    console.log(`job-hunter dashboard running at ${url}`);
    console.log("Press Ctrl+C to stop.");
    if (opts.open !== false) openBrowser(url);
  });

  // A listen failure (e.g. the port is taken) surfaces on the server's "error" event. Log a
  // human-readable line and exit non-zero so the OS-level service restarts us — this is what makes
  // the background service self-heal once the conflict clears.
  server.on("error", (error: unknown) => {
    const verdict = classifyListenError(error, port);
    console.error(verdict.message);
    process.exitCode = 1;
    server.close();
  });
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If `serve()`'s return type doesn't expose `.on`, narrow via the Node `http.Server` type that `@hono/node-server` returns — import `type { Server } from "node:http"` and annotate `const server: Server = ...`.)

- [ ] **Step 4: Smoke-check the happy path still works**

Run: `npm run build:web && npm run cli -- serve --no-open --refresh-hours 0`
Expected: prints `job-hunter dashboard running at http://localhost:4317`. Ctrl+C to stop.

- [ ] **Step 5: Smoke-check the conflict path**

In one terminal, leave the server above running. In a second terminal:
Run: `npm run cli -- serve --no-open --refresh-hours 0`
Expected: prints `Port 4317 is already in use; the dashboard could not start. It will retry.` and exits non-zero. Stop the first server afterward.

- [ ] **Step 6: Lint + commit**

```bash
npm run lint:fix
git add src/server/serve.ts
git commit -m "feat(server): exit non-zero on a listen failure so the service restarts"
```

---

### Task 3: Shared helpers for the shell scripts

A single sourced helper file keeps the five `.sh` scripts DRY: Node guard, path
resolution, log dir, and the LaunchAgent label/plist path. Bash only.

**Files:**
- Create: `scripts/service/common.sh`

**Interfaces:**
- Produces (sourced by Tasks 4–8):
  - `LABEL="com.job-hunter.dashboard"`
  - `PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"`
  - `require_node` — exits 1 with the install.sh wording if node missing or < 22.
  - `repo_dir` — absolute repo root (the dir containing `package.json`).
  - `data_dir` — `${JOB_HUNTER_HOME:-$HOME/.job-hunter}`.
  - `log_file` — `$(data_dir)/logs/dashboard.log` (creates the `logs` dir).
  - `node_bin` — absolute path to the node binary (`command -v node`).
  - `serve_entry` — `$(repo_dir)/src/cli/main.ts`.

- [ ] **Step 1: Write the helper**

```bash
# scripts/service/common.sh
# Shared helpers for the job-hunter dashboard service scripts (macOS). Sourced, not executed.

LABEL="com.job-hunter.dashboard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is required but was not found. Install Node 24 (see .nvmrc) from https://nodejs.org and re-run." >&2
    exit 1
  fi
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt 22 ]; then
    echo "job-hunter needs Node 22 or newer (found $(node -v)). Install Node 24 (see .nvmrc) from https://nodejs.org and re-run." >&2
    exit 1
  fi
}

repo_dir() {
  # This file lives at <repo>/scripts/service/common.sh
  cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
}

data_dir() {
  if [ -n "${JOB_HUNTER_HOME:-}" ]; then
    printf '%s' "$JOB_HUNTER_HOME"
  else
    printf '%s' "$HOME/.job-hunter"
  fi
}

log_file() {
  local dir
  dir="$(data_dir)/logs"
  mkdir -p "$dir"
  printf '%s' "$dir/dashboard.log"
}

node_bin() { command -v node; }

serve_entry() { printf '%s' "$(repo_dir)/src/cli/main.ts"; }
```

- [ ] **Step 2: Lint**

Run: `shellcheck scripts/service/common.sh`
Expected: no warnings. (If `shellcheck` is not installed: `brew install shellcheck`. If unavailable, note it as skipped and proceed.)

- [ ] **Step 3: Commit**

```bash
git add scripts/service/common.sh
git commit -m "feat(service): shared bash helpers for the macOS service scripts"
```

---

### Task 4: PowerShell shared helpers

The Windows analog of Task 3. PowerShell only.

**Files:**
- Create: `scripts/service/common.ps1`

**Interfaces:**
- Produces (dot-sourced by Tasks 5–8 `.ps1` scripts):
  - `$TaskName = "JobHunterDashboard"`
  - `Assert-Node` — throws with the install.ps1 wording if node missing or < 22.
  - `Get-RepoDir` — absolute repo root.
  - `Get-DataDir` — `$env:JOB_HUNTER_HOME` or `$env:APPDATA\job-hunter` (home if APPDATA absent).
  - `Get-LogFile` — `<data dir>\logs\dashboard.log` (creates `logs`).
  - `Get-NodeBin` — absolute node path.
  - `Get-ServeEntry` — `<repo>\src\cli\main.ts`.

- [ ] **Step 1: Write the helper**

```powershell
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
```

- [ ] **Step 2: Lint**

Run: `pwsh -c "Invoke-ScriptAnalyzer -Path scripts/service/common.ps1"`
Expected: no errors. (If PSScriptAnalyzer / pwsh unavailable on this machine, note as skipped — it will run on a Windows verification pass.)

- [ ] **Step 3: Commit**

```bash
git add scripts/service/common.ps1
git commit -m "feat(service): shared powershell helpers for the windows service scripts"
```

---

### Task 5: install + uninstall (macOS)

Write/load the LaunchAgent plist; remove it. Idempotent and loud on failure.

**Files:**
- Create: `service-install.sh`, `service-uninstall.sh`

**Interfaces:**
- Consumes: `scripts/service/common.sh`.
- Produces: a loaded LaunchAgent `com.job-hunter.dashboard` running `serve --no-open`.

- [ ] **Step 1: Write `service-install.sh`**

```bash
#!/usr/bin/env bash
# Install the job-hunter dashboard as a per-user background service (macOS).
# Starts at login, restarts on crash. No admin required. Usage: ./service-install.sh
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=scripts/service/common.sh
. "scripts/service/common.sh"

require_node

REPO="$(repo_dir)"
if [ ! -f "$REPO/web/dist/index.html" ]; then
  echo "The dashboard isn't built yet. Run ./install.sh first, then re-run this." >&2
  exit 1
fi

if [ -f "$PLIST" ]; then
  echo "Already installed. Run ./service-uninstall.sh first to reinstall." >&2
  exit 1
fi

NODE="$(node_bin)"
ENTRY="$(serve_entry)"
LOG="$(log_file)"
mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--import</string>
    <string>tsx</string>
    <string>$ENTRY</string>
    <string>serve</string>
    <string>--no-open</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLISTEOF

launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "Dashboard will start automatically at login. Open http://localhost:4317"
```

- [ ] **Step 2: Write `service-uninstall.sh`**

```bash
#!/usr/bin/env bash
# Remove the job-hunter dashboard background service (macOS). Usage: ./service-uninstall.sh
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=scripts/service/common.sh
. "scripts/service/common.sh"

if [ ! -f "$PLIST" ]; then
  echo "Nothing to remove."
  exit 0
fi

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Background service removed. (The dashboard is no longer running.)"
```

- [ ] **Step 3: Make executable + lint**

Run: `chmod +x service-install.sh service-uninstall.sh && shellcheck service-install.sh service-uninstall.sh`
Expected: no warnings.

- [ ] **Step 4: Manual check (macOS)**

Run: `./service-install.sh` then open `http://localhost:4317` (reachable). Then `./service-uninstall.sh` (URL stops responding).

- [ ] **Step 5: Commit**

```bash
git add service-install.sh service-uninstall.sh
git commit -m "feat(service): macOS install/uninstall via LaunchAgent"
```

---

### Task 6: start / stop / status (macOS)

The three remaining symmetric verbs.

**Files:**
- Create: `service-start.sh`, `service-stop.sh`, `service-status.sh`

**Interfaces:**
- Consumes: `scripts/service/common.sh`.

- [ ] **Step 1: Write `service-start.sh`**

```bash
#!/usr/bin/env bash
# Start the job-hunter dashboard service now (macOS). Usage: ./service-start.sh
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=scripts/service/common.sh
. "scripts/service/common.sh"
if [ ! -f "$PLIST" ]; then
  echo "Not installed. Run ./service-install.sh first." >&2
  exit 1
fi
# stop does `bootout` (unload), so start must `bootstrap` (load) again — kickstart alone only works
# on an already-loaded agent. bootstrap is a no-op error if already loaded, so ignore that case.
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "Started. Open http://localhost:4317"
```

- [ ] **Step 2: Write `service-stop.sh`**

```bash
#!/usr/bin/env bash
# Stop the job-hunter dashboard service (macOS). Usage: ./service-stop.sh
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=scripts/service/common.sh
. "scripts/service/common.sh"
if [ ! -f "$PLIST" ]; then
  echo "Not installed."
  exit 0
fi
# bootout (not a plain signal): with KeepAlive=true the agent would immediately respawn after a
# SIGTERM. bootout unloads it so it stays stopped until the next login or ./service-start.sh.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
echo "Stopped."
```

- [ ] **Step 3: Write `service-status.sh`**

```bash
#!/usr/bin/env bash
# Show whether the job-hunter dashboard service is running, plus recent log lines (macOS).
# Usage: ./service-status.sh
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=scripts/service/common.sh
. "scripts/service/common.sh"
if [ ! -f "$PLIST" ]; then
  echo "Not installed."
  exit 0
fi
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo "Running. Dashboard at http://localhost:4317"
else
  echo "Installed but not running. Run ./service-start.sh"
fi
LOG="$(log_file)"
if [ -f "$LOG" ]; then
  echo "--- recent log ($LOG) ---"
  tail -n 20 "$LOG"
fi
```

- [ ] **Step 4: Make executable + lint**

Run: `chmod +x service-start.sh service-stop.sh service-status.sh && shellcheck service-start.sh service-stop.sh service-status.sh`
Expected: no warnings.

- [ ] **Step 5: Manual check (macOS)**

Run: `./service-install.sh && ./service-status.sh` (Running) → `./service-stop.sh && ./service-status.sh` (not running) → `./service-start.sh && ./service-status.sh` (Running). Then `./service-uninstall.sh`.

- [ ] **Step 6: Commit**

```bash
git add service-start.sh service-stop.sh service-status.sh
git commit -m "feat(service): macOS start/stop/status verbs"
```

---

### Task 7: install + uninstall (Windows)

Register/unregister the at-logon scheduled task. Mirrors Task 5.

**Files:**
- Create: `service-install.ps1`, `service-uninstall.ps1`

**Interfaces:**
- Consumes: `scripts/service/common.ps1`.
- Produces: scheduled task `JobHunterDashboard` running `serve --no-open` at logon.

- [ ] **Step 1: Write `service-install.ps1`**

```powershell
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
```

- [ ] **Step 2: Write `service-uninstall.ps1`**

```powershell
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
```

- [ ] **Step 3: Lint**

Run: `pwsh -c "Invoke-ScriptAnalyzer -Path service-install.ps1, service-uninstall.ps1"`
Expected: no errors. (Skip with a note if PSScriptAnalyzer unavailable; runs on the Windows verification pass.)

- [ ] **Step 4: Commit**

```bash
git add service-install.ps1 service-uninstall.ps1
git commit -m "feat(service): windows install/uninstall via Task Scheduler"
```

---

### Task 8: start / stop / status (Windows)

Mirrors Task 6 for the scheduled task.

**Files:**
- Create: `service-start.ps1`, `service-stop.ps1`, `service-status.ps1`

**Interfaces:**
- Consumes: `scripts/service/common.ps1`.

- [ ] **Step 1: Write `service-start.ps1`**

```powershell
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
```

- [ ] **Step 2: Write `service-stop.ps1`**

```powershell
# Stop the job-hunter dashboard service (Windows). Usage: ./service-stop.ps1
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
. (Join-Path $PSScriptRoot "scripts\service\common.ps1")
if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Write-Host "Not installed."
    exit 0
}
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Write-Host "Stopped."
```

- [ ] **Step 3: Write `service-status.ps1`**

```powershell
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
```

- [ ] **Step 4: Lint**

Run: `pwsh -c "Invoke-ScriptAnalyzer -Path service-start.ps1, service-stop.ps1, service-status.ps1"`
Expected: no errors. (Skip with a note if unavailable.)

- [ ] **Step 5: Commit**

```bash
git add service-start.ps1 service-stop.ps1 service-status.ps1
git commit -m "feat(service): windows start/stop/status verbs"
```

---

### Task 9: Auto-restart on update + installer offer

Wire the service into the existing `update.*` (auto-restart if installed) and
`install.*` (end-of-setup offer). Detection is "is it installed?" — skip
silently otherwise so users who never enabled the service see no change.

**Files:**
- Modify: `update.sh` (append before the final echo), `update.ps1`, `install.sh`, `install.ps1`

**Interfaces:**
- Consumes: the Task 5/7 install state (plist file / scheduled task) and the Task 6/8 stop+start scripts.

- [ ] **Step 1: `update.sh` — auto-restart if installed**

Replace the final line:

```bash
echo "✓ Update complete. If 'npm run serve' is running, restart it to pick up the changes."
```

with:

```bash
if [ -f "$HOME/Library/LaunchAgents/com.job-hunter.dashboard.plist" ]; then
  echo "Restarting the background service to pick up the update…"
  ./service-stop.sh || true
  ./service-start.sh || true
fi
echo "✓ Update complete. If 'npm run serve' is running, restart it to pick up the changes."
```

- [ ] **Step 2: `update.ps1` — auto-restart if installed**

Replace the final line:

```powershell
Write-Host "Update complete. If 'npm run serve' is running, restart it to pick up the changes."
```

with:

```powershell
if (Get-ScheduledTask -TaskName "JobHunterDashboard" -ErrorAction SilentlyContinue) {
    Write-Host "Restarting the background service to pick up the update..."
    & "$PSScriptRoot\service-stop.ps1"
    & "$PSScriptRoot\service-start.ps1"
}
Write-Host "Update complete. If 'npm run serve' is running, restart it to pick up the changes."
```

- [ ] **Step 3: `install.sh` — end-of-setup offer**

Append after the final `npm run setup` line:

```bash
echo
read -r -p "Keep the dashboard running in the background (start at login)? [y/N] " reply
case "$reply" in
  [yY]*) ./service-install.sh ;;
  *) echo "Skipped. You can enable it later with ./service-install.sh" ;;
esac
```

- [ ] **Step 4: `install.ps1` — end-of-setup offer**

Append after the final `npm run setup` line:

```powershell
$reply = Read-Host "Keep the dashboard running in the background (start at logon)? [y/N]"
if ($reply -match '^[yY]') {
    & "$PSScriptRoot\service-install.ps1"
} else {
    Write-Host "Skipped. You can enable it later with ./service-install.ps1"
}
```

- [ ] **Step 5: Lint the shell changes**

Run: `shellcheck install.sh update.sh`
Expected: no warnings.

- [ ] **Step 6: Commit**

```bash
git add install.sh install.ps1 update.sh update.ps1
git commit -m "feat(service): auto-restart on update and offer install during setup"
```

---

### Task 10: Documentation

A "Keep the dashboard always running" section in README + INSTALL. The wiki
(separate repo) is a follow-up deliverable, noted at the end — not part of this
PR.

**Files:**
- Modify: `README.md` (after the dashboard section, ~line 93), `INSTALL.md`

**Interfaces:** none.

- [ ] **Step 1: Add the README section**

Insert after the dashboard description in `README.md`:

```markdown
### Keep the dashboard always running (optional)

To have the dashboard start automatically every time you log in — no terminal
needed — install it as a background service. Same commands on macOS and Windows:

```bash
./service-install.sh     # macOS/Linux   (or  ./service-install.ps1  on Windows)
```

The dashboard will be at <http://localhost:4317> after every login. Manage it with:

| Command | What it does |
|---|---|
| `service-install` | Start at login, from now on |
| `service-start` / `service-stop` | Start or stop it now |
| `service-status` | Is it running? (shows recent log) |
| `service-uninstall` | Stop starting it at login |

(On Windows, run the `.ps1` form, e.g. `./service-start.ps1`. If PowerShell
blocks the script, run it as `powershell -ExecutionPolicy Bypass -File ./service-start.ps1`.)

Running `./update.sh` (or `./update.ps1`) automatically restarts the service so
you get the new version with no extra steps. Logs are at
`~/.job-hunter/logs/dashboard.log` (macOS) or
`%APPDATA%\job-hunter\logs\dashboard.log` (Windows).
```

- [ ] **Step 2: Add a matching INSTALL.md note**

Add a short subsection to `INSTALL.md` pointing to the README section and listing the same commands.

- [ ] **Step 3: Commit**

```bash
git add README.md INSTALL.md
git commit -m "docs(service): document the background dashboard service"
```

- [ ] **Step 4: Note the wiki follow-up**

Print a reminder (do not edit the wiki here): the separate GitHub wiki repo's
user guide needs a mirror of this section. Tracked as a post-merge task.

---

### Task 11: Full verification + PR

Run the whole CI sequence, then the manual matrix on at least macOS, then open the PR.

**Files:** none (verification).

- [ ] **Step 1: Run the CI sequence**

Run: `npm run lint` then `npm run typecheck` then `npm run typecheck:web` then `npm run test:coverage` then `npm run build:web`
Expected: all pass; coverage gate green (the new `listen-error.ts` is covered).

- [ ] **Step 2: Run the macOS manual matrix**

Work through the 10-row matrix from the design doc
(`docs/superpowers/specs/2026-06-29-background-dashboard-service-design.md` →
Testing Strategy). Record any failures and fix before proceeding.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/background-service
gh pr create --repo jdelgadoperez/job-hunter --base main --head feat/background-service \
  --title "feat: run the dashboard as a background service (macOS + Windows)" \
  --body-file <prepared body>
```

Body should summarize: the symmetric command surface, the single `serve`
resilience change, the auto-restart-on-update behavior, and that the Windows
matrix rows are pending a Windows verification pass (call this out explicitly so
a reviewer knows what was and wasn't exercised locally).

---

## Notes for the implementer

- **Order matters:** Tasks 1→2 (helper before wiring), 3→5→6 (bash helper before bash scripts), 4→7→8 (ps1 helper before ps1 scripts). 9 depends on 5–8. 10–11 last.
- **`tsx` invocation:** the service runs `node --import tsx <entry> serve --no-open`, matching `package.json`'s `"serve": "node --import tsx src/cli/main.ts serve"`. Do not assume a compiled build.
- **You may not have a Windows machine.** Write the `.ps1` scripts carefully against this plan; the Windows matrix rows (and PSScriptAnalyzer) are a separate verification pass — flag them as unverified in the PR rather than claiming they pass.
- **Never claim a manual matrix row passed unless you ran it.** Report what was exercised and what wasn't.

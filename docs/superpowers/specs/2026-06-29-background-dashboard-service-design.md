# Background Dashboard Service — Design

**Date:** 2026-06-29
**Status:** Approved (design); implementation pending
**Topic:** Run the `job-hunter serve` dashboard as a per-user background service on macOS and Windows so it is always available without an open terminal.

## Objective

End users (non-engineers) on macOS and Windows can keep the local dashboard
(`job-hunter serve`) running in the background — it starts automatically at
login and survives terminal closes — using identical commands on both
platforms. Installing and removing the service must require no admin rights and
no knowledge of OS-native tools (`launchctl`, `schtasks`).

This is listed as a future direction in `README.md` ("packaging `serve`").

## Current State

- The app ships as a **cloned repo**, not an npm package (no `bin`/`files` in
  `package.json`). First-time setup is the existing `install.sh` / `install.ps1`
  pair; updates use `update.sh` / `update.ps1`.
- `job-hunter serve` (`src/server/serve.ts`) already:
  - binds **loopback only** (`127.0.0.1:4317`, `DEFAULT_PORT = 4317`),
  - supports **`--no-open`** (headless — no browser launch),
  - runs a **6h auto-refresh** scan scheduler while up,
  - serves the prebuilt `web/dist` (built by `install.sh` / `install.ps1`).
- `src/runtime/paths.ts` already resolves the data dir per-OS:
  `%APPDATA%\job-hunter` on Windows, `~/.job-hunter` on macOS/Linux
  (overridable via `JOB_HUNTER_HOME`).

The work is therefore **packaging and glue**, plus one small resilience change
to `serve`. No new app subsystems.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Privilege level | Per-user, **no admin**, both OSes | Dashboard is a per-user, loopback-only, unauthenticated tool over the user's own DB. A machine-wide service is a mismatch and would need elevation + a wrapper binary. |
| macOS mechanism | **LaunchAgent** (`~/Library/LaunchAgents`) | Native per-user service manager; `RunAtLoad` + `KeepAlive` give start-at-login and crash-restart. |
| Windows mechanism | **Task Scheduler**, "at log on" trigger | Native, no-admin, per-user. Symmetric with the LaunchAgent. |
| Command surface | **Full symmetric lifecycle**: `install / uninstall / start / stop / status` | Hard requirement: every command that exists on macOS exists identically on Windows. Users never touch `launchctl` / `schtasks`. |
| Script form | `.sh` + `.ps1` pairs (10 scripts) at repo root | Matches the existing `install.*` / `update.*` idiom. |
| Build handling | **Assume already built** (installer did it) | Instant login experience; no per-start build wait. |
| Update freshness | **`update.*` auto-restarts** the service if installed | New version goes live with zero extra steps; non-engineers never think about builds. |
| Logging | Single rolling `dashboard.log` in the data dir | A non-engineer's whole support interaction is "send me that file." |
| Port conflict | **Fixed 4317**; on conflict, log + OS retry | Predictable, bookmarkable URL; self-heals when the conflict clears. |
| Service command | `serve --no-open` | Headless — no browser pop on login. |
| Discoverability | Installer offer **+** README/INSTALL **+** wiki | Wiki lives in a **separate GitHub wiki repo** — tracked as a distinct deliverable, not in this repo's `docs/`. |

## Architecture & Components

### New files (repo root)

```
service-install.sh     service-install.ps1
service-uninstall.sh   service-uninstall.ps1
service-start.sh       service-start.ps1
service-stop.sh        service-stop.ps1
service-status.sh      service-status.ps1
```

Each script translates **one symmetric verb** into the OS-native call. The verb
and the user-visible behavior are identical across platforms; only the plumbing
differs.

| Verb | macOS | Windows |
|---|---|---|
| install | write plist → `launchctl bootstrap` + `kickstart` | `Register-ScheduledTask` (at-logon) + run now |
| uninstall | `launchctl bootout` + `rm` plist | `Unregister-ScheduledTask` |
| start | `launchctl kickstart` | `schtasks /Run` |
| stop | `launchctl bootout` (session) | `schtasks /End` |
| status | `launchctl print` → running? + log tail | `schtasks /Query` + log tail |

### macOS artifact

`~/Library/LaunchAgents/com.job-hunter.dashboard.plist`, with `RunAtLoad` +
`KeepAlive`, `ProgramArguments` = absolute node + serve entrypoint + `--no-open`,
`StandardOutPath` / `StandardErrorPath` → the log file.

### Windows artifact

Scheduled task `JobHunterDashboard`, "at log on" trigger, action = absolute
`node` + serve entrypoint + `--no-open`, output redirected to the log file.

### Touched existing files

- `update.sh` / `update.ps1` — auto-restart the service **if installed**
  (existence check on the plist / task; silent skip otherwise).
- `install.sh` / `install.ps1` — end-of-setup offer: "Keep the dashboard
  running in the background? [y/N]" → run `service-install` if yes.
- `README.md` + `INSTALL.md` — a "Keep the dashboard always running" section.
- `src/server/serve.ts` — handle `EADDRINUSE` (see Error Handling).

### Separate-repo deliverable

- The GitHub **wiki repo** user guide — a section mirroring the README docs.
  Tracked separately; not part of this repo's PR.

## Data Flow

### Install (`service-install`)

```
1. Verify Node present + version >= 22       (same guard as install.*)
2. Verify web/dist exists                    (else: "Run ./install first", exit 1)
3. Resolve ABSOLUTE paths: node binary, repo dir, serve entrypoint, log dir
     log dir: ~/.job-hunter/logs | %APPDATA%\job-hunter\logs   (created if absent)
4. Render the OS artifact with those absolute paths baked in
5. Load + start it now
6. Print: "Dashboard will start automatically at login. Open http://localhost:4317"
```

Absolute paths are mandatory: a login-time service has no working directory, no
`fnm`/`nvm` shell context, and no controlled `PATH` — everything resolves at
install time.

### Runtime (every login, no human)

```
OS scheduler -> node <repo>/src/cli/main.ts serve --no-open
            -> binds 127.0.0.1:4317, starts 6h auto-refresh scheduler
            -> stdout/stderr -> logs/dashboard.log
```

### Update (`update.*`, augmented)

```
existing: git pull -> npm install -> build:web
NEW:      if service installed -> service-stop then service-start  (new web/dist goes live)
          else                 -> skip silently
```

## Error Handling

Repo rule: **failures degrade, never crash.** Applied by context:

### Install / uninstall time (a human is watching) — fail loud and clear

| Failure | Behavior |
|---|---|
| Node missing / < 22 | Same wording as `install.*`; exit 1 |
| `web/dist` missing | "The dashboard isn't built yet. Run `./install` first, then re-run this." exit 1 |
| Already installed | Detect existing plist/task → "Already installed. Use `service-uninstall` first to reinstall." (idempotent) |
| LaunchAgents dir / APPDATA unwritable | Surface the OS error + the path attempted |
| `launchctl` / `schtasks` nonzero exit | Print the tool's stderr + the exact command; exit nonzero |
| uninstall when not installed | "Nothing to remove." exit 0 |

### Runtime (no human attached) — degrade and self-heal

| Failure | Behavior |
|---|---|
| Port 4317 busy | `serve` logs the bind error → exits → OS restarts → self-heals when the port frees. URL stays 4317. |
| DB locked / transient | Existing `serve` resilience; crash → OS restart |
| Repeated crash-loop | `KeepAlive` throttles (macOS ~10s min interval); the log shows the repeating error |

### The one application-code change

`serve` must catch the listener `EADDRINUSE`, log a one-line human message
(`port 4317 is in use; will retry`), and **exit non-zero** so the OS scheduler
restarts it. Today this may surface as an unhandled rejection. This is the only
change to app code; everything else is packaging. It is unit-testable and stays
inside the coverage gate.

## Testing Strategy

The feature is mostly shell/PowerShell + OS schedulers, which the vitest suite
cannot exercise — the same category as `install.sh` / `update.ps1` / the
Playwright renderer (already excluded from the coverage gate, covered by opt-in
smoke scripts). Mocking `launchctl` would test the mock, not the behavior.

### 1. Unit tests (in vitest, inside the coverage gate)

The only real app logic — `serve` `EADDRINUSE` handling:

- When the listener emits `EADDRINUSE`, `serve` logs the one-line message and
  exits non-zero.
- The normal listen-success path still logs the URL (regression guard).
- Use a faked/injected listener — no real port bound — consistent with the
  suite's existing dependency-injection of network seams.

### 2. Excluded-edge scripts (no automated coverage, documented as such)

The 10 lifecycle scripts are I/O against the OS. Not faked. Covered by a manual
verification matrix (below), the analog of the existing `smoke:*` scripts.

### 3. Manual verification matrix (run once per OS before shipping)

| # | Step | Expected (macOS & Windows) |
|---|---|---|
| 1 | `service-install` | Exits 0; `localhost:4317` reachable within seconds |
| 2 | Log out / back in (or reboot) | Auto-starts; reachable with no terminal open |
| 3 | `service-status` | "running" + log tail |
| 4 | `service-stop` → status | "stopped"; `localhost:4317` dead |
| 5 | `service-start` → status | Back to "running" |
| 6 | Manual `serve` first, then `service-install` | Logs port-busy + retries; URL stays 4317; self-heals after manual serve killed |
| 7 | `service-install` when already installed | "Already installed…"; no duplicate |
| 8 | `update` while service installed | Service auto-restarts; new build live, no manual step |
| 9 | `service-uninstall` → reboot | No auto-start; `localhost:4317` dead; artifact gone |
| 10 | `service-uninstall` when not installed | "Nothing to remove." exit 0 |

### 4. Script hygiene (cheap static guard)

- `shellcheck` on the `.sh` scripts
- `PSScriptAnalyzer` on the `.ps1` scripts

Catches unquoted paths-with-spaces and missing error-exit. Documented as a
pre-ship step. Wiring these into CI is deferred (needs the linters on the
runner) unless explicitly requested.

### Out of scope (deliberately)

No real LaunchAgents/Task Scheduler entries in CI; no cross-OS CI matrix for the
scripts. Disproportionate for a 10-thin-script packaging feature. The unit test
covers the only real logic; the matrix covers integration; linting covers
foot-guns.

## Success Criteria

1. On both macOS and Windows, a non-engineer can run `service-install` and the
   dashboard is reachable at `http://localhost:4317` and auto-starts at login.
2. The same five verbs (`install/uninstall/start/stop/status`) work identically
   on both platforms with no admin rights.
3. Running `update` while the service is installed makes the new version live
   with no extra user action.
4. A port conflict does not require user intervention — the URL stays 4317 and
   the service self-heals.
5. All failures are either a clear install-time message or a logged,
   self-healing runtime event — never a crash on login.
6. The `serve` `EADDRINUSE` change is unit-tested and the coverage gate stays
   green.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Node not on the service's `PATH` at login | Resolve the absolute node binary at install time and bake it into the artifact. |
| `fnm`/`nvm` shims absent in the login environment | Same — never rely on shell-managed node; use the resolved absolute path. |
| Windows execution policy blocks `.ps1` | Document the `-ExecutionPolicy Bypass` invocation in README/INSTALL, matching how `install.ps1` is already run. |
| Stale `web/dist` after update | `update.*` auto-restart (decision above) eliminates it. |
| Crash-loop hammering at login | OS-level restart throttling + the log file for diagnosis. |
| Wiki drift (separate repo) | Tracked as an explicit, separate deliverable in the plan. |

## Open Questions

None blocking. One deferred decision: whether to wire `shellcheck` /
`PSScriptAnalyzer` into CI (needs the linters on the runner) vs. keeping them a
documented pre-ship step. Current plan: documented pre-ship step.

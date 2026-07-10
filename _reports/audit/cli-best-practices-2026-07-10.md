# CLI Best-Practices Audit — job-hunter

Date: 2026-07-10
Source rubric: https://github.com/lirantal/nodejs-cli-apps-best-practices (33 numbered practices)
Scope: the terminal CLI (`src/cli/`, `bin/job-hunter`, `package.json`). The web dashboard is out of scope.

## Already solid

| # | Practice | Evidence |
|---|----------|----------|
| 1.4 | Color + `NO_COLOR`/`FORCE_COLOR`/`TERM=dumb`/non-TTY | `src/cli/style.ts:19-25` (built on `node:util` `styleText`) |
| 1.7 | Zero-config sensible defaults | scan/list run without setup |
| 1.9 | `-h`/`--help`, per-subcommand help, examples, invalid-flag → help | `src/cli/help.ts`, `src/cli/parse.ts:83-88` |
| 3.6 | STDOUT (data) vs STDERR (errors) split | `src/cli/main.ts:221-225`, `:311-314` |
| 4.2 | Graceful degradation to plain output | `style.ts` |
| 6.2 | Actionable errors | `src/cli/main.ts:68-72` ("Run `job-hunter profile <file>` first") |
| 6.4 | Correct exit codes via `process.exitCode` | throughout `src/cli`, `src/server/serve.ts:137` |
| 7.1 | `bin` object in package.json | `package.json:8` |
| 9.1 | `--version`/`-v` | `src/cli/parse.ts`, `src/runtime/version.ts` |
| 9.2/9.3/9.7 | SemVer + release-please + CHANGELOG | repo release history |

## Gaps accepted for implementation (2026-07-10)

Ranked by value for a local-first data CLI. All selected by the user.

| # | Gap | File(s) touched | Effort | Status |
|---|-----|-----------------|--------|--------|
| 3.2 | No `--json` output on `list`/`score` | `parse.ts`, `commands.ts`, `main.ts` | Med | Not yet done (PR B/C) |
| 1.8 | No `SIGINT`/`SIGTERM` handling (`serve`, `scan`) | `serve.ts`, `main.ts` | Med | Not yet done (PR B/C) |
| 4.3 | No `engines.node` field | `package.json` | Trivial | **Done — PR A** |
| 6.3 | No debug mode (`--verbose`/`DEBUG=`) | `main.ts`, `style.ts`/new logger | Med | Not yet done (PR B/C) |
| 6.5 | No bug-report URL on crash; no `.github/ISSUE_TEMPLATE/` | `main.ts`, `.github/` | Low | **Done — PR A** |
| 1.1 | Sparse short flag aliases (`-p` for `--port`, etc.) | `parse.ts`, `help.ts` | Low | **Done — PR A** |
| 10.1 | Audit `service` child-process spawns for arg injection | `src/cli/service.ts` | Low | **Done — PR A** |
| 3.7 | No shell completion | new completion command | High | Not yet done (PR B/C) |
| 4.4 | bin is a bash+tsx wrapper, not `#!/usr/bin/env node` | `bin/`, build, install | Med-High | Not yet done (PR B/C) |

**PR A shipped (2026-07-10):** 4.3 (`engines.node` + runtime guard), 1.1 (short flag aliases
`-p`/`-a`/`-l`/`-n`), 6.5 (bug-report URL on crash + issue template), and 10.1 (service
argument-injection audit test) landed on `feat/cli-quick-wins`. Plan:
`docs/superpowers/plans/2026-07-10-cli-pr-a-quick-wins.md`. Remaining rows (3.2, 1.8, 6.3, 3.7, 4.4)
are scoped to future PRs (B/C) and are not yet implemented.

## Deliberately skipped (not defects for this tool)

- **1.3 / 3.4** — config lives in SQLite settings, not dotfiles. Deliberate design choice.
- **2.1 / 2.2 / 2.3 / 7.3 / 9.6** — not published to npm; installed via symlink (`command-install.sh`).
- **4.1** — no Docker image (local-first desktop tool).
- **8.1** — no telemetry (correct; nothing to opt into).
- **1.6** — clickable hyperlinks: minor polish, deferred.

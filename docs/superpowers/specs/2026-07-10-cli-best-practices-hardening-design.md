# CLI Best-Practices Hardening — Design Spec

Date: 2026-07-10
Status: Approved (design), pending implementation plan
Rubric: https://github.com/lirantal/nodejs-cli-apps-best-practices (33 numbered practices)
Audit report: `_reports/audit/cli-best-practices-2026-07-10.md`
Full rubric copy: `_reports/audit/nodejs-cli-checklist-rubric.md`

## Objective

Bring the `job-hunter` terminal CLI into line with a selected set of nine Node.js
CLI best practices, delivered as three themed, independently-reviewable PRs. The web
dashboard (`web/`) is out of scope; this touches only `src/cli/`, `bin/`,
`src/server/serve.ts`, `package.json`, and `.github/`.

Non-goals: npm publishing concerns (shrinkwrap, `files` field, Docker), telemetry,
dotfile-based config (settings deliberately live in SQLite), clickable hyperlinks.

## Current state (from CLI map)

- Entry: `package.json:8` `"bin": { "job-hunter": "bin/job-hunter" }`; `bin/job-hunter`
  is a `#!/usr/bin/env bash` wrapper that `exec node --import <tsx-loader> src/cli/main.ts`.
  No build step for the CLI — `tsx` runs TypeScript source directly.
- Parser: hand-rolled dispatch (`src/cli/parse.ts:77` `parseCli`) over `node:util`
  `parseArgs`. No arg-parsing dependency.
- Help: hand-authored `COMMANDS` array (`src/cli/help.ts:20-147`), per-subcommand help,
  examples. `-h`/`--help`/`help` and `-v`/`--version`/`version` recognized anywhere in argv.
- Color: `src/cli/style.ts` on `node:util` `styleText`, respects `NO_COLOR`/`FORCE_COLOR`/
  `TERM=dumb`/non-TTY. Exemplary.
- Output: `console.log` (stdout) for data/help/version, `console.error` (stderr) for
  errors. But in-flow warnings/progress currently go to **stdout** via the `log` callback.
- Errors: `process.exitCode` (never `process.exit()`), actionable messages, degrade-not-crash.
- Absent: `--json`, `--verbose`/`DEBUG`, SIGINT/SIGTERM handling, `engines.node`,
  short flag aliases, bug-report URL, `.github/ISSUE_TEMPLATE/`, shell completion.

## Delivery: three themed PRs

Diagnostics-to-stderr discipline (3.6) is the backbone enabling `--json` and `--verbose`
to coexist; PR B establishes it. PR C is the only one touching install/runtime plumbing
and process lifecycle — reviewed last, independently.

---

### PR A — Quick wins

Pure additions; no change to happy-path behavior.

**4.3 — `engines.node`**
- Add `"engines": { "node": ">=22" }` to `package.json` (matches the documented
  "Node 24; 22+ required" claim in `CLAUDE.md`, currently unenforced).
- Add a soft runtime guard early in `src/cli/main.ts`: if
  `Number(process.versions.node.split(".")[0]) < 22`, print a friendly styled message to
  **stderr** naming the required version and continue (do not hard-crash). Guideline 4.3
  wants a friendly error, not an abort.

**1.1 — Short flag aliases**
- Additive short aliases in `parse.ts` `parseArgs` options and documented in `help.ts`:
  - `serve`: `-p` → `--port`
  - `track add`: `-n` → `--name`
  - `score`: `-l` → `--limit`
  - `scan`: `-a` → `--all`
- No removals, no renames. Existing long flags unchanged.

**6.5 — Effortless bug reports**
- On the top-level catch in `main.ts` (`main().catch(...)`), after the styled error,
  append a stderr line: `Report this: https://github.com/jdelgadoperez/job-hunter/issues/new`.
- Add `.github/ISSUE_TEMPLATE/bug_report.md` with a template prompting for
  `job-hunter --version`, OS, Node version, command run, and expected/actual.

**10.1 — Argument-injection audit**
- Audit `src/cli/service.ts` child-process spawns. Confirm array-form args (no
  concatenated shell string) and that no user-controlled value reaches a shell.
- The `service <action>` positional is already constrained to a fixed enum
  (`install|uninstall|start|stop|restart|status`) — verify and document. Fix only if a
  hole exists; otherwise record the audit result in the PR description. No feature change.

**PR A tests**: alias parsing (each new short flag resolves to its long option);
runtime-guard message emitted on a simulated low version; service action rejects an
unknown value.

---

### PR B — Output & observability

Establishes the stderr discipline, then layers `--json` and `--verbose` on top.

**3.6 — STDOUT/STDERR discipline (enabling refactor)**
- Introduce a single diagnostic sink used by the command layer for progress, warnings,
  and debug — routed to **stderr**. Human-mode primary results stay on stdout.
- Progress/warning lines that currently go through the `log` (stdout) callback in
  `src/cli/commands.ts` move to the diagnostic (stderr) sink. Rationale: they are
  diagnostics, not the command's primary data output. Effect: `job-hunter scan 2>/dev/null`
  cleanly silences progress; `job-hunter list --json` stdout is pure JSON.
- This is a behavior change for scan progress location (stdout → stderr). Call it out in
  the PR; it is the correct behavior per 3.6 and is required for `--json`.

**3.2 — `--json` structured output**
- Add `--json` boolean flag to `list` and `score`.
- **`list --json`** emits a JSON **array of match records** to stdout — the flattened form of
  the `ScoredPosting` rows `listScoredPostings` returns: `score`, `company`, `title`, `url`,
  `source`, `location`, `remote`, `country`, `postedAt` (ISO or null), `applied` (bool),
  `expired` (bool). `Date` fields serialize as ISO strings. No new data invented.
- **`score --json`** emits the `ScoreOutcome` run summary as a JSON **object**
  `{ counts, estimate, warnings, abortedOnLimit }` — the machine-readable form of what
  `formatScorePlan` prints. Refinement (2026-07-10): `score` produces a run summary, NOT a
  list of matches, so forcing it into a match array would misrepresent it. The object form is
  honest to the command and is the natural target for `--dry-run` cost scripting.
- Define both shapes with zod schemas (repo already uses zod at the web contract boundary)
  so the CLI JSON output has a validated, stable contract. Schemas reused by the tests.
- In `--json` mode: result to stdout as a single `JSON.stringify(value, null, 2)`; ALL
  diagnostics (progress, warnings) to stderr via the PR-B sink. No human table, no ANSI.

**6.3 — Debug mode (`--verbose` + `DEBUG`)**
- Global `--verbose` flag (recognized like `-h`/`-v`, anywhere in argv) AND
  `DEBUG=job-hunter*` env var both enable diagnostic-level logging.
- Small `createDebugLogger(namespace)` helper writing to **stderr**, no-op unless enabled.
  Not the `debug` npm package — a tiny local helper (no new dependency; consistent with the
  repo's "avoid unnecessary dependencies" stance). Honors the same `NO_COLOR`/TTY rules as
  `style.ts`.
- Seed debug statements at pipeline boundaries in `commands.ts` (discover start/end, per-
  connector resolution, score start/end, persistence).

**PR B tests**: `list --json` stdout parses as JSON and contains no ANSI/human text;
diagnostics land on stderr not stdout (assert stdout is pure JSON while a warning is
emitted); `--verbose` enables debug output and default run does not; `DEBUG=job-hunter*`
enables it via env. JSON asserted against the zod schema (locale-independent per 5.1).

---

### PR C — Lifecycle

Install/runtime plumbing and process lifecycle. Highest blast radius; reviewed last.

**1.8 — SIGINT / SIGTERM handling**
- `serve` (long-running): register `SIGINT`/`SIGTERM` handlers that close the HTTP
  listener (`server.close()`) and any open resources, then exit `0`. Idempotent (guard
  against double-invocation).
- `scan` (network/browser work): thread an `AbortController` into the scan entry; on
  signal, abort in-flight fetch/render and stop at the next pipeline boundary, then exit
  `130` (128 + SIGINT) per convention. Minimal-but-correct: if fully threading the abort
  proves large, the fallback is to stop cleanly at the next `company`/`posting` boundary
  and exit 130 — no orphaned browser process. The plan will pick the smallest correct cut.

**4.4 — `#!/usr/bin/env node` entry**
- Replace `bin/job-hunter` (bash) with `bin/job-hunter.mjs`:
  ```
  #!/usr/bin/env node
  import { register } from "tsx/esm/api";
  register();
  await import("../src/cli/main.ts");
  ```
  (Exact tsx register API confirmed against tsx docs during implementation.)
- Update `package.json` `bin` to point at `bin/job-hunter.mjs`.
- Update `command-install.sh` symlink target to the new file; keep it executable.
- `tsx` moves from dev-only to a **runtime dependency** (it is now required to run the
  installed CLI). No dist/compile step is introduced — this satisfies 4.4's `env node`
  intent while keeping the tsx-on-source model.
- Remove the now-unused bash wrapper and its `TSX_TSCONFIG_PATH` handling, migrating any
  needed env into the `.mjs` stub.

**3.7 — Shell completion**
- Add `job-hunter completion <bash|zsh|fish>` subcommand. Prints a completion script to
  **stdout**, generated from the existing `COMMAND_NAMES` / `COMMANDS` metadata so it stays
  in sync with the real command set. Diagnostics (e.g. "unsupported shell") to stderr.
- Never mutates `.bashrc`/`.zshrc`/PowerShell profiles. README/help documents the manual,
  reversible install step (user redirects output themselves).

**PR C tests**: SIGINT handler registered and `server.close()` invoked on signal (serve);
scan abort path exits 130 without orphaned resources (mocked); `completion bash` output
contains every subcommand name and no locale-dependent assertions; unsupported shell errors
to stderr with nonzero exit.

---

## Cross-cutting

- **Conventions**: TypeScript-strict, ESM, `@app/*` alias, Biome (2-space, 100-col, double
  quotes), Conventional Commits, NO Claude co-author footer. Colocated `*.test.ts`, offline
  (injected deps + fixtures). Coverage gate (stmts 93 / branches 85 / funcs 90 / lines 93)
  must stay green.
- **Strong typing**: no `!` assertions; avoid type assertions outside tests. `--json` shape
  is a zod schema + inferred type, not a hand-written interface duplicated.
- **Degrade-not-crash** preserved: none of these changes may make a single company/posting
  failure abort a scan.
- **Verification per PR**: `npm run lint`, `npm run typecheck`, `npm test` green; manual
  smoke of the touched command (e.g. `job-hunter list --json | jq .`, Ctrl+C during
  `serve`, `job-hunter completion bash`).

## Sequencing

PR A → PR B → PR C. B depends on nothing in A but is cleaner after A's small parser
additions land. C's shebang change is independent but sequenced last so lifecycle/install
risk is isolated from the additive work.

## Success criteria

Each selected practice (4.3, 1.1, 6.5, 10.1, 3.2, 6.3, 3.6, 1.8, 4.4, 3.7) verifiably
satisfied by its "How to verify" check in the rubric, with a colocated test where testable,
CI green, and the audit report's gap table updated to reflect what shipped.

# Incremental scan with configurable freshness — Design

## Context

"2 · Scan for jobs" (dashboard) and `job-hunter scan` (CLI) currently re-visit **every** company on
every run — the whole directory plus every tracked company. For a large directory this is slow and
wasteful when most companies were scanned minutes or hours ago and haven't changed.

The user wants scanning to skip companies scanned recently by default ("scan jobs that have not been
scanned"), with an explicit option to force a full re-visit ("an option to rescan"). This mirrors the
deep-score panel's "unscored by default, re-score on demand" pattern, applied to the scan/discovery
step at the **company** level.

### What already exists (the foundation)

- **Scoped scans**: `ScanScope = "full" | "retry"` (`src/discovery/scan-store.ts:5`). The
  retry-failed feature (PR #87/#88) already crawls a *filtered subset* of companies via
  `scope: "retry"` — the scoped-runner infrastructure exists (`src/server/scan-runner.ts:62`).
- **Per-company timestamps**: the `companies` table already has
  `last_seen_scan INTEGER NOT NULL` and `last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))`
  (`src/storage/schema.ts:84-86`). "When was this company last scanned" is already recorded — **no
  schema change needed**.
- **Settings resolution**: `scanFreshnessHours` follows the existing `scorerModel`/`refreshHours`
  pattern (`src/matching/resolve-settings.ts`).

## Scope decision

- **Default `Scan now` = incremental**, skipping companies scanned within a freshness window.
- **`Rescan all` override** forces `scope: "full"`.
- **Freshness window is configurable** via a `scanFreshnessHours` setting (default **24**), surfaced
  in the dashboard Settings tab and overridable per-CLI-run.
- **Time-based only** — no content-change detection (YAGNI).

## Design

### 1. New scan scope: `"incremental"` (`src/discovery/scan-store.ts`)

Extend the union: `ScanScope = "full" | "retry" | "incremental"`. Reuses the existing scoped-crawl
machinery; `"retry"` is untouched.

### 2. Incremental company selection (`src/storage/repository.ts`)

New method, e.g. `listCompaniesToScan(opts: { freshnessHours: number }): CompanyRef[]`, returning the
directory companies whose `last_seen_at` is older than `now - freshnessHours` (or NULL / never
scanned). **Tracked companies are always included** regardless of freshness (a just-added company
must be scanned now). No schema change — reads the existing `last_seen_at`.

The scoped scan crawls only these leads; the **directory diff still runs against the full directory
snapshot**, so new/removed-company detection is unaffected by which companies were crawled.

### 3. Freshness setting (`resolve-settings.ts` + settings table + `settings-keys.ts`)

- New key `SCAN_FRESHNESS_SETTING = "scanFreshnessHours"`.
- `resolveScanFreshnessHours(settings): number` — returns the stored value if a valid positive
  number, else the default `SCAN_FRESHNESS_HOURS_DEFAULT = 24`. A stored `0` disables skipping
  (treated as full — see edge cases).
- Surfaced in the dashboard **Settings** tab as a number input (like the existing knobs); persisted
  through the settings API. CLI reads the same setting.

### 4. Server + API (`src/server/app.ts`, `scan-runner.ts`, `types.ts`)

- `POST /api/scan` accepts an optional `{ scope?: "full" | "incremental" }` body, **defaulting to
  `"incremental"`**. (`"retry"` stays on its own `/api/scan/retry-failed` route — not exposed here.)
- `parseScanOptions` (new, mirrors `parseScoreOptions`) validates the scope.
- `createScanRunner` builds the incremental lead list (via `listCompaniesToScan`) when
  `scope === "incremental"`, mirroring the retry-failed scoped runner at `scan-runner.ts:62`. `"full"`
  keeps today's whole-directory behavior.

### 5. UI (`web/src/views/Home.tsx`, `web/src/api.ts`)

- **"Scan now"** runs incremental by default.
- A **"Rescan all"** checkbox beside it forces `scope: "full"` (mirrors the deep-score "Re-score
  already-scored" toggle).
- The scan request body carries `{ scope }`; `web/src/api.ts` zod schema + the drift test updated to
  match.
- Panel copy: *"Scans companies not checked in the last N hours. Tick 'Rescan all' to re-visit every
  company now."* — N pulled from settings (fall back to the default when unset).

### 6. CLI surface (`src/cli/main.ts`, `commands.ts`, `help.ts`)

- `scan` defaults to **incremental**.
- `scan --all` forces `scope: "full"`.
- `scan --freshness-hours N` overrides the setting for that run (like `--remote`/`--no-remote`
  overriding `config remote`).
- Help text updated; the scan plan/summary reports which scope ran and how many companies were
  **skipped as fresh**.

### 7. Edge cases (each gets a test)

- **First-ever scan** (empty `companies` table): incremental returns all — nothing has a
  `last_seen_at`, so nothing is skipped. Behaves like full.
- **Tracked companies**: always crawled, freshness ignored — a just-added company is scanned now.
- **Freshness = 0**: disables skipping → behaves like full (mirrors `--refresh-hours 0` disabling
  auto-refresh).
- **New directory companies**: no `last_seen_at` → always crawled, so new roles are never missed.
- **Directory diff integrity**: the new/removed delta compares the full directory snapshot,
  independent of the crawl scope — incremental scans don't corrupt the "what changed" report.
- **Liveness/expiry must not punish skipped companies** — the one real correctness risk. An
  incremental scan that skips a fresh company must NOT expire that company's still-live postings just
  because they weren't seen this run. The existing `expireStalePostings` already guards this: it
  counts only `kind = 'full'` scans toward the consecutive-miss threshold
  (`repository.ts:668` — `WHERE kind = 'full' AND id > postings.last_seen_scan AND id <= ?`), which is
  exactly why the retry scope is safe today. This protection is **automatic**: `startScan(kind)`
  writes the scope straight into `scans.kind` (`repository.ts:506-509`), and `ScanScope` *is* the
  `kind` value. So an incremental scan started as `startScan("incremental")` records
  `kind = 'incremental'`, which the expiry query's `kind = 'full'` filter already excludes — no extra
  code, the same path the `'retry'` scope relies on. The `scans.kind` column already exists
  (`schema.ts:76`, default `'full'`). Passing `"incremental"` through to `startScan` is the
  load-bearing invariant, and it gets an explicit regression test (a skipped company's live postings
  survive an incremental run).

### 8. Testing (TDD, colocated, offline, gate 93/85/90/93)

- `repository.test.ts`: `listCompaniesToScan` — stale companies returned, fresh excluded, tracked
  always included, empty DB returns all, freshness=0 returns all. Plus: a skipped company's live
  postings are not expired by the incremental run.
- Scan-pipeline test (`commands.test.ts`): `scope: "incremental"` crawls only selected leads;
  directory diff still runs full; plan reports skipped-as-fresh count.
- `resolve-settings.test.ts`: `scanFreshnessHours` resolves from setting else default 24; a stored
  `0` disables; `--freshness-hours` override wins over the stored value.
- `app.test.ts`: `POST /api/scan` defaults to incremental; honors `scope: "full"` from the body;
  rejects an invalid scope.
- Web tests: "Rescan all" checkbox sends `scope: "full"`; default sends `"incremental"`; Settings
  number input persists the freshness value; `api.ts` drift test covers the new field.

## Non-goals / flags

- **Retry-failed unchanged** — `"retry"` stays its own scope/route; incremental is a sibling.
- **No Postgres-worker change** — the hosted worker crawls the full directory centrally; incremental
  is a *local-client* optimization. `ScanScope` gains a variant the worker simply never uses.
- **Time-based only** — no content-hash / ETag change detection.
- **Expiry must respect skips** — the one real correctness risk; §7 + its test guard it.
- **This is a separate feature from the country-parsing change** — its own spec, plan, and PR.

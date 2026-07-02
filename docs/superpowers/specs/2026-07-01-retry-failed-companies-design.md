# Smart follow-up scanning for warned companies — Design

**Date:** 2026-07-01
**Status:** Approved design

## Summary

Today, a scan's per-company fetch failures (e.g. "Scanned and scored 10339 postings — 130
warning(s)") are surfaced once and then discarded — there's no way to retry just the failures
without re-running a full scan. This adds two layers of resilience:

1. **In-run retry** — after the main crawl, automatically retry companies whose fetch failed once
   more before the scan finishes, recovering from transient blips (timeouts, brief outages) without
   any user action.
2. **Cross-scan persistence** — companies still failing after the retry are recorded; once one hits
   5 consecutive scan failures, it's excluded from the automatic retry pass (still gets the normal
   first attempt every scan) and surfaced in a new "Needs attention" list, with a manual rescan
   action in both the CLI and the dashboard.

## Scope

**In scope:** per-company fetch failures only — warnings where a specific company's careers page
failed to fetch (ATS connector error, browser render failure/timeout).

**Out of scope (not retried/tracked):**
- Source-level failures (e.g. "Airtable directory unreachable") — retrying against no specific
  target doesn't make sense; the whole scan needs to be re-run.
- The intentional "Skipped N companies on sites we don't scrape (LinkedIn/Indeed)" notice — this
  isn't a failure to recover from, it's a deliberate skip already surfaced via the existing
  `/api/companies/manual-review` list.
- The hosted Postgres scan worker (`src/backend/scanner/`, `ScanStore`). It produces the shared
  community directory feed for all users and has no per-user "needs attention" concept. This
  feature is local-only, built on the SQLite `Repository`.

## Decisions (resolved during brainstorming)

| Question | Decision |
|---|---|
| Auto-retry vs. persist-for-manual vs. both | Both — auto-retry in-run, then persist anything still failing. |
| Which warnings are retryable | Per-company fetch failures only (see Scope). |
| Retry timing | One retry pass after the main crawl finishes, not inline per-failure. |
| Cross-scan surfacing | New DB table + dashboard "Needs attention" panel + CLI flag. |
| Backoff threshold | 5 consecutive scan failures (a distinct constant from `expireStalePostings`'s `staleAfter=2` — a whole-company fetch failure is a heavier, rarer signal than one posting disappearing, and scans may run infrequently, so more patience avoids false-flagging a company mid-recovery). |
| CLI flag name | `--retry-failed` |
| UI exposure | Yes — a "Needs attention" panel with a per-company "Rescan" button, alongside the CLI flag. |

## Global constraints

Copied from CLAUDE.md; every task inherits these.

- TypeScript-strict, ESM, ES2022; `noUncheckedIndexedAccess`, `noImplicitOverride` on.
- No `!` non-null assertions. No type assertions outside tests.
- No new runtime dependencies (reuse `p-limit`, already a dependency).
- Biome: 2-space, 100-col, double quotes. Verify with `npm run lint` at full project scope.
- Tests colocated, offline, fixture-driven. Coverage gate stays green: statements 93 / branches 85 /
  functions 90 / lines 93.
- **Failures degrade, never crash** — the retry pass and persistence must not turn a warning into a
  thrown error; a failure to persist `failed_leads` should log/warn, not abort the scan.
- Conventional Commits. No Claude co-authored footer.

## Architecture

### 1. `Warning` gains an optional target (`src/domain/types.ts`)

```ts
export type Warning = {
  source: string;
  message: string;
  /** The careers URL this warning is about, when it's a per-company fetch failure. Absent for
   * source-level failures (e.g. "Airtable directory unreachable") and the unscrapable-host notice —
   * those aren't retry targets. */
  careersUrl?: string;
};
```

`discover.ts` sets `careersUrl` only on the two per-company failure sites (`fetchLead` catch, and
`result.ok === false` from a connector). The source-fan-out failure and the unscrapable-host skip
notice continue to omit it. This field is the retry/persistence filter: "has `careersUrl`" ==
"retryable."

### 2. In-run retry pass (`src/discovery/discover.ts`)

After the existing `collected` fan-out (today: lines ~157–195), split `collected` into ok/failed.
For failed entries with a `lead.careersUrl` (i.e., not source-level), run one additional pass
reusing the same `fetchLead`/`limit`/`waitTurn` — same concurrency and pacing as the main pass, just
over a smaller lead list. A company that now succeeds gets folded into `byId` as normal; anything
still failing keeps (or gets) its `Warning` with `careersUrl` set. No new module — this is a second,
smaller loop inside `discover()`, sharing its existing helpers.

The function signature and `DiscoverResult` shape are unchanged — the retry is invisible to callers
except that fewer warnings survive and more postings appear.

### 3. Persisted "needs attention" list (`src/storage/schema.ts`, `src/storage/repository.ts`)

New table:

```sql
CREATE TABLE IF NOT EXISTS failed_leads (
  careers_url TEXT PRIMARY KEY,
  company TEXT,
  message TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 1,
  last_failed_scan INTEGER NOT NULL
);
```

(`careers_url` reuses the same `normalizeCareersUrl` normalization as `tracked_companies`/`companies`
— see the prior PR — so casing/trailing-slash variants collapse to one row.)

New `Repository` methods:

- `recordScanFailures(scanId: number, failures: { careersUrl: string; company: string; message: string }[]): void` —
  called once per scan with the final (post-retry) per-company warnings. For each: upsert, incrementing
  `consecutive_failures` when the row already exists, else inserting at 1. Any company **not** in
  `failures` this scan that currently has a row gets that row deleted (it recovered — clear its
  history, matching how `expireStalePostings`/liveness re-check "revive" a posting rather than
  keeping stale counters).
- `listNeedsAttention(threshold = 5): { careersUrl: string; company: string; message: string; consecutiveFailures: number }[]` —
  rows at or above `threshold`, for the CLI/UI "Needs attention" surfaces.
- `listRetrySkipUrls(threshold = 5): string[]` — just the normalized URLs at/over threshold, for
  `discover()`'s retry pass to skip (still attempted on the main pass every scan — only the *extra*
  retry is skipped once demoted, so a company doesn't burn two attempts every scan once it's known-bad).

### 4. Wiring into the scan (`src/discovery/discover.ts`, `src/cli/commands.ts`)

`DiscoverDeps` gains an optional `skipRetryFor?: Set<string>` (normalized careers URLs) — when a
lead's normalized URL is in this set, it's excluded from the retry pass (but not the main pass).

`runScan()` (not `runSourcing()` — see Scope: this must stay off the shared `ScanStore` seam) does,
after `runSourcing()` returns:

```ts
const perCompanyFailures = sourced.warnings
  .filter((w): w is Warning & { careersUrl: string } => w.careersUrl !== undefined);
repo.recordScanFailures(scanId, perCompanyFailures.map((w) => ({
  careersUrl: w.careersUrl,
  company: w.source,
  message: w.message,
})));
```

(Type-guard filter, not a `!` assertion — keeps the "no non-null assertions" constraint intact.)

This requires `runScan` to have the `scanId` `runSourcing` opened — `runSourcing`'s return type
(`SourcingOutcome`) does not currently expose it. Add `scanId: number` to `SourcingOutcome`, threaded
from the `startScan()` call already inside `runSourcing`. (Non-breaking additive field; the Postgres
worker's caller ignores it.)

`discover()`'s `skipRetryFor` is populated in `runScan`/CLI wiring from `repo.listRetrySkipUrls()`
before the scan starts, passed through `discoverDeps`.

### 5. Manual rescan — CLI (`src/cli/parse.ts`, `src/cli/main.ts`, `src/cli/commands.ts`)

`job-hunter scan --retry-failed`:

- `parse.ts`: the `"scan"` case gains an options object (matching the `score` subcommand's
  `parseArgs`-style pattern), with `"retry-failed": { type: "boolean" }`. `ParsedCommand`'s `scan`
  variant becomes `{ kind: "scan"; retryFailed: boolean }`.
- `runScanCommand` (main.ts) accepts the flag. When true, it scopes discovery to *only* the
  `listNeedsAttention()` companies (constructing `trackedCompanies` from just that list, and passing
  `sources: []` so `collectLeads` doesn't re-pull the full directory — mirroring the existing
  `sourceFromFeedAndTracked`'s `sources: []` pattern for a scoped crawl). Still runs through the
  normal `runScan` path (sourcing + scoring), so results land in the DB and matches update normally.
- If the needs-attention list is empty, log a friendly no-op message and exit without scanning.

### 6. Manual rescan — Dashboard (`src/server/app.ts`, `web/src/`)

New read endpoint, parallel to the existing manual-review one:

```
GET /api/companies/needs-attention → repo.listNeedsAttention()
```

New rescan-trigger endpoint, reusing the existing background scan-job machinery
(`src/server/scan-runner.ts`/`scan-job.ts`) rather than inventing a second job runner:

```
POST /api/scan/retry-failed → starts a background scan job scoped to listNeedsAttention()
   (same single-flight 202/409 semantics as POST /api/scan already has)
```

Web (`web/src/api.ts`, `hooks.ts`): `getNeedsAttention()` + `useNeedsAttention()` query;
`retryFailedScan()` mutation hitting the new endpoint, invalidating the scan-status query (reuses
the existing scan-status polling the dashboard already has for `POST /api/scan`).

UI (`web/src/views/Home.tsx`, next to the existing manual-review list): a "Needs attention" panel —
company name, last failure message, consecutive-failure count, and a "Rescan" button that calls the
new mutation and shows the same in-progress scan indicator the regular "Scan now" button uses.

## Data flow

```
scan runs → discover() main pass → per-company failures collected
  → discover() retry pass (same run) → still-failing kept as Warning{careersUrl}
  → runSourcing() returns (scanId, postings, warnings, ...)
  → runScan(): repo.recordScanFailures(scanId, perCompanyFailures)
      - recovered companies: row deleted
      - still-failing: consecutive_failures += 1 (or inserted at 1)
      - at threshold (5): appears in listNeedsAttention(), excluded from next scan's retry pass

next scan → discover({ ..., skipRetryFor: listRetrySkipUrls() })
   → still attempted on the main pass; retry pass skips it

manual rescan (CLI --retry-failed / dashboard "Rescan")
   → scoped discover() over just listNeedsAttention() companies
   → success clears the row via the same recordScanFailures path
```

## Error handling

- `recordScanFailures` failing (e.g. a locked DB) must not abort the scan — wrap in the same
  "failures degrade" posture as the rest of `runScan`; log and continue, since the scan itself has
  already succeeded by this point.
- A company demoted to "needs attention" is never silently dropped from future full scans — it's
  still crawled on the main pass every time; only the extra retry attempt is skipped. This means a
  company can still self-heal via the main pass without ever using `--retry-failed`.
- `--retry-failed` / the dashboard "Rescan" action against an empty needs-attention list is a no-op
  with a clear message, not an error.
- If a manual rescan itself fails again, it goes through the same `recordScanFailures` path — no
  special-casing.

## Testing strategy

Colocated, offline, existing patterns.

- **`discover.test.ts`:** a lead that fails on the first pass but succeeds on retry ends up in
  `postings`, not `warnings`. A lead that fails both passes keeps its `Warning{careersUrl}`. A
  source-level failure and an unscrapable-host skip never appear in the retry pass (assert the mock
  fetcher's per-lead call count to distinguish "attempted twice" from "attempted once"). `skipRetryFor`
  excludes a lead from the retry pass but not the main pass.
- **`repository.test.ts`:** `recordScanFailures` inserts new rows at `consecutive_failures=1`,
  increments on repeat failure, deletes the row when a previously-failing company is absent from a
  later call. `listNeedsAttention` returns only rows at/over the threshold; `listRetrySkipUrls`
  returns just their normalized URLs.
- **`commands.test.ts`:** `runScan` calls `recordScanFailures` with exactly the per-company
  (`careersUrl`-bearing) warnings, not source-level ones; `SourcingOutcome`/`ScanOutcome` expose
  `scanId`.
- **`parse.test.ts`:** `scan --retry-failed` parses to `{ kind: "scan", retryFailed: true }`; bare
  `scan` defaults `retryFailed: false`.
- **`main.test.ts`:** `--retry-failed` scopes discovery to `listNeedsAttention()` companies with
  `sources: []`; empty list short-circuits with a message and no scan.
- **`app.test.ts`:** `GET /api/companies/needs-attention` returns `listNeedsAttention()`;
  `POST /api/scan/retry-failed` follows the existing single-flight 202/409 contract.
- **Web:** `api.ts`/`hooks.ts` request/param construction covered under `test:web`; component-level
  assertion of the "Needs attention" panel rendering + button wiring if the existing `Home.test.tsx`
  patterns make it cheap to add.

## Risks

- **`SourcingOutcome` gaining `scanId`** touches the `ScanStore`-shared `runSourcing`, even though the
  *consumption* of `scanId` is local-only. Mitigation: purely additive field, the hosted worker
  (`src/backend/scanner/run-once.ts`) already destructures only what it needs and can ignore it —
  verify its test doesn't assert an exact-shape equality that would break on an extra field.
  This risk was surfaced during architecture review (initial assumption was that persistence could
  live inside `runSourcing`/`ScanStore` directly — corrected to keep the Postgres worker untouched).
- **Retry pass doubling worst-case scan time for a fully-down source** — if many companies share one
  flaky upstream (e.g. a shared ATS host having an outage), the retry pass retries all of them, roughly
  doubling the time spent on that batch. Accepted: bounded by the same concurrency cap as the main
  pass, and only affects the (usually small) failed subset, not the whole scan.
- **5-scan threshold is a guess, not measured** — may need tuning once real failure patterns are
  observed (e.g. a company whose board is down for a week would take 5 scans to demote, which could
  be too patient or not patient enough depending on real scan cadence). Accepted as a starting point;
  easy to adjust as a constant later.

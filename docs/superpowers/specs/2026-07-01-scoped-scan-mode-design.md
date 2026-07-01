# Scoped-Scan Mode for `--retry-failed` — Design

**Date:** 2026-07-01
**Status:** Approved (brainstorm)
**Branch:** `feat/retry-failed-companies` (fix on top of the smart-follow-up-scanning feature)
**Related:** `2026-07-01-retry-failed-companies-design.md` (the feature this corrects)

## Problem

The "smart follow-up scanning" feature added a scoped rescan of only the
needs-attention companies, exposed as `job-hunter scan --retry-failed` (CLI) and a
dashboard "Rescan" button (`POST /api/scan/retry-failed`). Both narrow the crawl to
the needs-attention subset (`trackedCompanies = needsAttention`, `sources = []`) but
still run the full sourcing pipeline `runSourcing`.

`runSourcing` assumes it saw the **entire** directory this scan. It unconditionally:

1. opens a new scan via `startScan()` (advances the global `scanId`),
2. computes a removed-companies diff in `recordDirectory` (anything previously seen
   but absent *this* scan is "removed"),
3. re-checks liveness of every posting not seen this scan (`recheckLiveness` →
   `listLivePostingsNotSeen`), re-fetching each source URL, and
4. expires postings whose `last_seen_scan` is `>= staleAfter` (2) scans behind the
   current `scanId` (`expireStalePostings`).

Feeding a *subset* of the directory through this pipeline corrupts state. A
high-effort code review confirmed four resulting defects (plus two independent bugs
in the retry machinery):

| # | Severity | Location | Defect |
|---|----------|----------|--------|
| 1 | **Blocker** | `runSourcing` `expireStalePostings` + scanId advance | A scoped run advances `scanId` but stamps `last_seen_scan` only on the needs-attention companies. After ≥2 scoped runs (or one scoped run then a full scan) the `scanId` gap trips `expireStalePostings`, silently expiring **healthy postings from every un-crawled company**. Data loss from a routine action. |
| 2 | **Blocker** | `runSourcing` `recheckLiveness` | Dashboard "Rescan" reuses the unconditional liveness re-check, so re-scanning a handful of failed companies re-fetches the source URL of **every stored posting** — a full-directory sweep, slow and rate-limit-tripping. |
| 3 | Important | `recordDirectory` removed-diff | With only needs-attention companies in `currentUrls`, `recordDirectory` reports **every healthy company from the last full scan as "removed"** (`-N gone` in the CLI summary and dashboard diff). Misleading, not corrupting. |
| 4 | Important | `runScan` `skipRetryFor` | On a `--retry-failed` run, `skipRetryFor` is loaded with the exact needs-attention URLs being crawled, so `discover()`'s in-run retry pass skips them — the companies you asked to retry get **only one attempt**, defeating the feature's purpose. |
| 5 | Important | `discover()` retry pass | The in-run retry `Promise.all` bypasses the `pLimit(concurrency)` cap and `waitTurn()` politeness delay the main pass uses. A directory-wide blip → dozens of failures → an unbounded simultaneous re-fetch burst. Affects **full scans too**. |
| 6 | Minor | `useRetryFailedScan` | Never invalidates `["companies","needs-attention"]`, so the panel shows recovered companies until a page reload. |

The four confirmed data/behavior bugs (#1–#4) share one root cause: **a scoped scan
runs full-scan bookkeeping as if it observed the whole directory.**

## Guiding principle

A scoped retry run **refreshes only the companies it crawls**. It does not
participate in directory bookkeeping — no removed-diff, no liveness re-check, no
expiry — and it must not advance the staleness clock a later full scan reads
(clean-skip, *not* re-stamping survivors).

Full scans (`job-hunter scan` with no flag, and the hosted Postgres worker) keep
their current behavior exactly. Every change below defaults to full-scan semantics so
those paths are byte-for-byte unchanged.

## Design

### 1. A `scope` on the sourcing pipeline (fixes #2, #3, and the in-run half of #1)

Thread a scan scope through `runSourcing`:

```ts
type ScanScope = "full" | "retry";
```

`SourcingDeps` gains `scope?: ScanScope` (default `"full"`). When `scope === "retry"`,
`runSourcing`:

- **still** `startScan("retry")`, upserts/stamps the crawled postings, and upserts the
  crawled companies' rows (so retried companies refresh), and calls `finishScan`;
- **skips** the removed-companies computation in `recordDirectory` — the crawled
  companies are still upserted (their `last_seen_scan` advances), but the returned
  diff has `removedCompanies: []` (and `newCompanies: []`, since "new vs. the whole
  directory" is meaningless for a subset);
- **skips** `recheckLiveness` entirely;
- **skips** `expireStalePostings` entirely.

`recordDirectory` gains a scope-aware path. The cleanest shape: a parameter
`recordDirectory(scanId, companies, { computeRemoved: boolean })` — a full scan passes
`true` (current behavior), a retry scan passes `false` (upsert only, empty diff). This
keeps the upsert (needed so retried companies' `last_seen_scan` advances) while
dropping the whole-directory removed-diff.

Because `startScan`, `recordDirectory`, `expireStalePostings`, and `recheckLiveness`'s
inputs all sit behind the shared `ScanStore` seam, the new parameters are **optional
and default to today's behavior**, so `PostgresScanStore` and `run-once.ts` (which only
ever run full scans) need no change.

### 2. Full-scan-only staleness clock (fixes the persistent half of #1)

Even with the retry run skipping its own expiry, its `startScan()` advances the global
`scanId`. A *later full scan* would then compute an inflated `scanId − last_seen_scan`
gap and wrongly expire healthy postings. Fix: measure staleness in **full scans
elapsed**, not raw `scanId` gap.

- Add a column to the `scans` table (additive migration, idempotent `migrate()` path):
  ```sql
  ALTER TABLE scans ADD COLUMN kind TEXT NOT NULL DEFAULT 'full';
  ```
  Existing rows and any future full scan default to `'full'`; scoped runs record
  `'retry'`.
- `startScan` accepts the kind: `startScan(kind: ScanScope = "full"): number`,
  persisting it. The `ScanStore` interface widens to
  `startScan(kind?: ScanScope): number | Promise<number>` — optional, default `"full"`,
  so the Postgres store is unaffected.
- `expireStalePostings(currentScanId, staleAfter = 2)` expires a posting when **at
  least `staleAfter` full scans have finished since its `last_seen_scan`**, via a
  subquery counting full scans strictly newer than the posting's last-seen scan:
  ```sql
  UPDATE postings SET expired_at = datetime('now')
  WHERE expired_at IS NULL AND last_seen_scan IS NOT NULL
    AND (SELECT COUNT(*) FROM scans
         WHERE kind = 'full' AND id > postings.last_seen_scan) >= ?
  ```
  Scoped (`'retry'`) scans are invisible to this count, so no number of scoped runs
  can push a healthy posting toward expiry. A posting last seen on full scan *N* still
  needs two *full* scans (*N+1*, *N+2*) to elapse before expiring — unchanged semantics
  for the full-scan path.

### 3. Scoped run does not self-skip its retry pass (fixes #4)

The `skipRetryFor` list exists so a routine full scan doesn't re-hammer known-bad
companies in the in-run retry pass. On a `--retry-failed` run those companies are
exactly what we want to retry. So: **a retry-scope run passes an empty
`skipRetryFor`** (equivalently, `runScan` only builds the skip-list when
`scope === "full"`). The needs-attention companies then get their normal main-pass
attempt plus the in-run retry.

### 4. Retry pass respects concurrency + politeness (fixes #5)

In `discover()`, the in-run retry pass currently maps `toRetry` through a raw
`Promise.all(... fetchLead ...)`. Change it to reuse the same bounded scheduler the
main pass uses: each retried lead goes through `await waitTurn()` then
`limit(() => fetchLead(lead))` (the existing `pLimit(concurrency)` instance and
`waitTurn` delay). This bounds the retry burst identically to the main pass and
benefits full scans as well as scoped ones.

### 5. UI invalidates needs-attention after a Rescan (fixes #6)

`useRetryFailedScan` (or a completion effect on the Companies view, mirroring Home's
`finishedAt` effect) invalidates the `["companies","needs-attention"]` query when the
retry scan transitions to done, so a recovered company drops off the panel without a
reload. Follow the existing scan-completion invalidation pattern in `Home.tsx` rather
than inventing a new one.

## Deferred (filed as follow-ups, not in this fix)

- **#7 — feed-recovered companies never cleared (PLAUSIBLE).** In hybrid feed mode,
  `attemptedUrls` is `local.companies` only, so a company that recovers via the shared
  feed (not the local crawl) is never removed from `failed_leads`. The correct fix
  needs a stable company key on postings — the same `companyId` relational-key
  follow-up already deferred from the original feature. Track together.
- **#8 — empty-list Rescan reports false success (PLAUSIBLE).** A retry-failed job that
  finds an empty needs-attention list returns `{ count: 0 }` as a normal completion,
  giving no "nothing to rescan" signal. UX polish; safe to defer.
- **#9 — `createRetryFailedScanRunner` near-duplicates `createScanRunner`.** Extract a
  shared runner parameterized by `trackedCompanies` + `scope`. Do opportunistically if
  the scope change touches both runners anyway; otherwise defer.
- **#10 — redundant careers-URL normalization in `discover()`.** Precompute a
  normalized key per failed lead instead of re-normalizing up to three times. Micro-opt.

## Components changed

| Unit | Responsibility | Change |
|------|----------------|--------|
| `src/discovery/scan-store.ts` | Shared sourcing seam | `startScan(kind?: ScanScope)`; `recordDirectory` scope-aware signature — both optional/defaulted so Postgres store is unaffected. |
| `src/storage/schema.ts` | SQLite schema | `scans.kind TEXT NOT NULL DEFAULT 'full'`; additive `migrate()` step. |
| `src/storage/repository.ts` | SQLite store | `startScan(kind)`, `recordDirectory(..., {computeRemoved})`, `expireStalePostings` full-scan-count staleness. |
| `src/cli/commands.ts` | `runSourcing` / `runScan` | Thread `scope`; skip removed-diff/recheck/expiry on `"retry"`; build `skipRetryFor` only on `"full"`; pass `scope` from `runScan`. |
| `src/cli/main.ts` | CLI `--retry-failed` wiring | Pass `scope: "retry"` for a scoped run. |
| `src/server/scan-runner.ts` | Dashboard retry runner | Pass `scope: "retry"`. |
| `src/discovery/discover.ts` | In-run retry pass | Route retried leads through `waitTurn()` + `limit(...)`. |
| `web/src/hooks.ts` (+ Companies view) | Rescan mutation | Invalidate `["companies","needs-attention"]` on retry-scan completion. |

## Error handling

Unchanged from the feature: sourcing and scoring collect `Warning`s and return partial
results; a scoped run that fails degrades exactly as a full one does. The existing
degrade-never-crash try/catch around `recordScanFailures` stays. No new failure modes:
every scope branch is a *narrowing* of work a full scan already does.

## Testing strategy

Colocated, offline (DI + fixtures), one regression test per fix, each derived from
seeded inputs (no hardcoded literals mirroring the implementation):

1. **#1 expiry:** seed a full scan stamping company A + B; run a `"retry"` scan
   crawling only A; then a second full scan; assert B's healthy postings are **not**
   expired (they would be under the old raw-`scanId` gap). Also assert the full-scan
   expiry path still expires a genuinely-stale posting after two full scans.
2. **#2 liveness:** a `"retry"` scan does not call `listLivePostingsNotSeen` /
   re-fetch non-crawled postings (assert via a spy/injected fetcher that no re-check
   fetch fires for un-crawled companies).
3. **#3 removed-diff:** a `"retry"` scan returns `removedCompanies: []` and logs no
   `gone` for un-crawled companies; a full scan still reports removals.
4. **#4 retry pass:** a `"retry"` run passes an empty `skipRetryFor`, so a
   needs-attention company failing its main pass gets a second in-run attempt (assert
   two fetch attempts for that lead).
5. **#5 politeness:** the retry pass respects the concurrency cap and inter-request
   delay (assert max in-flight ≤ cap, or that `waitTurn` is invoked per retried lead).
6. **#6 UI:** after a retry scan completes, the needs-attention query is invalidated
   (RTL + mocked fetch; assert a refetch of `/api/companies/needs-attention`).

Full CI-equivalent suite stays green: `lint`, `typecheck`, `typecheck:web`,
`test:coverage` (gate 93/85/90/93), `test:web`, `build:web`. The Postgres worker seam
(`run-once.ts`, `PostgresScanStore`) must remain behaviorally unchanged — new
parameters are optional and default to `"full"`.

## Success criteria

- A local-only user running `job-hunter scan --retry-failed` any number of times
  between full scans never loses a healthy posting to expiry.
- A dashboard "Rescan" re-fetches only the needs-attention companies, not the whole
  directory.
- A scoped run never reports healthy companies as removed.
- `--retry-failed` gives its companies the full main-pass + in-run retry.
- The in-run retry pass is concurrency-bounded and polite on full and scoped scans.
- The needs-attention panel self-refreshes after a Rescan.
- Full scans and the hosted Postgres worker are behaviorally identical to before.

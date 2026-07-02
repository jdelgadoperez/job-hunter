# Cross-store `companyId` Relational Key — Design

**Date:** 2026-07-02
**Status:** Approved (brainstorm)
**Branch:** `feat/company-id-relational-key` (off `main` @ `dc75e83`, which includes merged PR #87)
**Related:** deferred follow-up #7 from `2026-07-01-retry-failed-companies-design.md` and
`2026-07-01-scoped-scan-mode-design.md`.

## Problem

Postings relate to companies only by fuzzy matching — a posting's `company` column is a denormalized,
overloaded string (an ATS board token for feed/ATS postings, a display name for browser-fallback
postings; see `src/domain/types.ts:8-14`), and companies are keyed by `careers_url`. There is no
stable key linking a posting (or a `failed_leads` row) to a company. Two concrete consequences from
the just-merged retry-failed feature:

1. A scoped `--retry-failed` run scopes only the local crawl; the shared **feed** is still pulled
   whole, because feed postings carry no company key to filter on.
2. A company that recovers **via the feed** (its postings reappear in the shared feed) is never
   cleared from `failed_leads`, because the retry run's "attempted" set is built from locally-crawled
   companies only.

## Goal

Give companies a stable, content-derived `companyId` that is **identical in the local SQLite store and
the hosted Postgres worker** with no cross-store coordination, so postings and `failed_leads` can
reference companies unambiguously. This unblocks (1) scoping the feed to needs-attention companies and
(2) clearing feed-recovered companies from `failed_leads`.

## Why a content hash (decided)

`postings.id` is already a **portable content hash** —
`makePostingId = sha256(lower(company + " " + title + " " + url)).slice(0,16)`
(`src/discovery/posting-id.ts`), computed client-side before any DB write. That is exactly why a
posting's `id` is byte-identical whether crawled locally or read from the feed
(`src/discovery/feed/posting-feed.ts:44-49`): same input, same hash, no DB sequence involved.

`careers_url` is a portable natural key already present in both stores' `companies` tables. So
`companyId = sha256(normalizeCareersUrl(careersUrl)).slice(0,16)` is portable the same way — identical
in both stores by construction. No worker-assigned id, no `remoteId` mapping layer. This mirrors the
one id-generation pattern the codebase already uses.

`scans.id` and `profiles.id` are non-portable autoincrement/serial ids that never cross the
store boundary; they are explicitly **out of scope**.

## Design

### 1. `makeCompanyId` helper — new file `src/discovery/company-id.ts`

Sibling to `posting-id.ts`:

```ts
import { createHash } from "node:crypto";
import { normalizeCareersUrl } from "@app/domain/normalize";

/**
 * Stable identifier for a company, derived from its normalized careers URL. Because
 * `normalizeCareersUrl` is deterministic, the same company yields the same id in the local SQLite
 * store and the hosted Postgres worker with no coordination — the same portability property that
 * makes `makePostingId` byte-identical across stores.
 */
export function makeCompanyId(careersUrl: string): string {
  return createHash("sha256").update(normalizeCareersUrl(careersUrl)).digest("hex").slice(0, 16);
}
```

`normalizeCareersUrl` lives in `src/domain/normalize.ts` (used already by `companies`/`failed_leads`
writes). Hash the **normalized** URL so casing / trailing slash / query-string variants collapse to
one id.

### 2. Schema changes (additive, both stores)

| Column | Store(s) | Nullable | Notes |
|--------|----------|----------|-------|
| `companies.id TEXT` | SQLite + Postgres | populated by backfill | Added indexed column. `careers_url` stays PRIMARY KEY. |
| `postings.company_id TEXT` | SQLite + Postgres | yes | Legacy rows NULL; self-heal on re-crawl. |
| `failed_leads.company_id TEXT` | SQLite only | populated by backfill | `failed_leads` has no Postgres table. |

- **`companies.id` is an added column, NOT a PK swap.** `careers_url TEXT PRIMARY KEY` stays — it is
  load-bearing for `ON CONFLICT(careers_url)` upserts in `recordDirectory` and `addTrackedCompany`
  (both stores). `id` is always derivable from `careers_url`, so there is no independent identity to
  protect by making it the PK; swapping it would touch every INSERT/UPSERT for no benefit and risk a
  data-loss window. Add `CREATE UNIQUE INDEX idx_companies_id ON companies(id)`.
- **SQLite migration:** additive `ALTER TABLE ... ADD COLUMN` inside `Repository.migrate()`, each
  guarded by a `PRAGMA table_info(<table>)` check exactly like the existing
  `postings`/`match_results`/`scans` column guards. New indexes added to the `INDEXES` block created
  after the ALTERs.
- **Postgres migration:** append `alter table ... add column if not exists` + `create index if not
  exists` to `src/backend/schema.sql`, following the idempotent-ALTER convention already at the bottom
  of that file. Applied MANUALLY (`psql -f src/backend/schema.sql`) — there is no CI migration runner
  (see §6 deploy runbook).

### 3. Where `companyId` is computed and stamped

**In `discover()`, not in connectors.** Connectors stay pure `(boardToken) → JobPosting[]` transforms
and have no `CompanyLead`; threading `careersUrl` through 10+ connector signatures would be churn for
no benefit. `src/discovery/discover.ts` already destructures `{ lead, result }` (with
`lead.careersUrl` in scope) at both the main-pass loop (~lines 174-182) and the retry-pass loop
(~lines 202-214), where `result.postings` is inserted into `byId`. Stamp there:

```ts
for (const posting of result.postings) {
  byId.set(posting.id, { ...posting, companyId: makeCompanyId(lead.careersUrl) });
}
```

Add `companyId?: string` to `JobPosting` (`src/domain/types.ts`) — optional because legacy DB rows
and old-worker feed rows won't have it (see §4, §6). Because `discover()` is the single code path both
the local scan (`cli/main.ts`, `server/scan-runner.ts`) and the worker
(`backend/scanner/run-once.ts` → `runSourcing` → `sourceFromFullCrawl` → `discover`) run, **both
stores get `company_id` identically for free** with no worker-specific stamping code.

`savePosting`'s upsert SET clause gains `company_id = excluded.company_id` (SQLite `repository.ts` +
Postgres `postgres-scan-store.ts`) so live postings backfill their `company_id` naturally as they are
re-seen on subsequent scans.

### 4. Migration / backfill of existing rows

- **`companies.id`:** fully backfillable — `careers_url` is always present. Compute via the TypeScript
  `makeCompanyId` (single source of truth for the hash). SQLite: in `migrate()`, after adding the
  column, UPDATE each row whose `id IS NULL`. Postgres: a one-time Node backfill script that reads
  rows and issues per-row UPDATEs using the same `makeCompanyId` (NOT an in-SQL `digest()`, to avoid a
  SQL-vs-TS hex/truncation mismatch).
- **`failed_leads.company_id`:** fully backfillable (careers_url is the PK). Same approach in
  `migrate()`.
- **`postings.company_id`:** NOT reliably backfillable — posting rows never stored `careers_url`, and
  `company` is the overloaded token/name field with no clean join to `companies.careers_url`. **Leave
  legacy posting rows NULL.** New and re-crawled postings are stamped going forward (§3); since live
  postings are re-upserted every full scan, essentially all live postings gain `company_id` within
  1-2 scan cycles. Expired postings may keep NULL forever — acceptable, since they are not retry or
  feed-scoping targets.

  **Invariant: every consumer treats a NULL/undefined `companyId` as "unknown — do not exclude,"
  never as "definitely not a match."** (Degrade-never-crash.)

### 5. `--retry-failed` feed-scoping payoff

Two-part change inside `runScan` / `runSourcing` / `sourceFromFeedAndTracked` (`src/cli/commands.ts`):

- **(a) Scope the feed.** Thread `companyIdFilter?: Set<string>` (the needs-attention companyIds,
  = `new Set(needsAttention.map(c => makeCompanyId(c.careersUrl)))`) from `runScan` → `runSourcing` →
  `sourceFromFeedAndTracked`, populated only when `scope === "retry"`. Filter:
  `feedResult.postings.filter(p => !companyIdFilter || (p.companyId && companyIdFilter.has(p.companyId)))`.
  On a `full` scan `companyIdFilter` is undefined → no filtering (unchanged behavior, so a
  NULL-companyId feed posting is never dropped on a full scan). Under a retry filter, a feed posting
  passes only if its `companyId` is in the needs-attention set; a NULL/undefined-companyId posting
  won't match and is excluded from the scoped set — correct, because an unidentifiable feed posting is
  not evidence that a *specific* needs-attention company recovered.
- **(b) Clear feed-recovered companies.** `sourceFromFeedAndTracked` returns which needs-attention
  companies appeared in the (filtered) feed result (new `recoveredFromFeed: CompanyRef[]` on
  `SourceResult`). `runScan` unions their `careersUrl` into the `attemptedUrls` it already passes to
  `repo.recordScanFailures(scanId, failures, attemptedUrls)` (`repository.ts`), so a company that
  recovered via the feed is cleared from `failed_leads` (which deletes rows in
  `attemptedSet ∩ ¬currentFailures`).

`recordScanFailures` and `failed_leads` remain keyed by `careersUrl` — no schema change there beyond
the additive `company_id` column; the companyId is used to *match feed postings*, then mapped back to
`careersUrl` for the existing clear logic.

### 6. Worker + feed contract + backward compatibility

- `src/backend/postgres-mappers.ts`: carry `company_id`/`companyId` through `PostingRow`,
  `PostingInsert`, `postingToRow`, `rowToPosting` — following the existing optional-field pattern for
  `location`/`country` (`...(x ? { x } : {})`).
- `src/backend/postgres-scan-store.ts`: add `company_id` to the `savePosting` and `savePostings`
  column lists and their `ON CONFLICT ... DO UPDATE SET`.
- `src/discovery/feed/posting-feed.ts`: add `company_id: z.string().nullish()` to `FeedRow`, add
  `company_id` to `COLUMNS`, map `r.company_id ?? null → companyId`.

**Highest-risk invariant — `FeedRow.company_id` MUST stay `z.nullish()` (never required).** The feed
is read by a possibly-older client hitting a newer worker, or (more likely) a newer client hitting an
old worker not yet redeployed. If the field were required, an old-worker feed row lacking `company_id`
would fail zod validation, and `HttpPostingFeed.fetch` degrades a validation failure to a `Warning`
with an empty result — i.e. **a silent full-feed outage for every user** until the worker redeploys.
Nullish keeps it a graceful degrade: `companyId: undefined` → retry-scoping falls back to
scope-local-crawl-only (today's behavior).

**Deploy runbook (manual, coordinated — no CI migration runner):**
1. Run the `schema.sql` ALTERs against Supabase (`psql "$DATABASE_URL" -f src/backend/schema.sql`).
2. Run the one-time Postgres `companies.id` backfill script.
3. Deploy the worker code (starts stamping `company_id`); let it run 1-2× to populate feed rows.
4. The local client changes ship in the same PR; feed-scoping activates once the worker is emitting
   `company_id`. Shipping the client first is safe (nullish → no crash) but retry feed-scoping simply
   no-ops until the worker catches up.

### 7. Test strategy

Colocated, offline (DI + fixtures), coverage gate 93/85/90/93.

- `src/discovery/company-id.test.ts` (mirror `posting-id.test.ts`): deterministic for the same URL;
  URL variants that `normalizeCareersUrl` collapses (trailing slash, query, case) yield the **same**
  id (cross-store parity proof); 16-char lowercase hex.
- `src/discovery/discover.test.ts`: main-pass and retry-pass postings are stamped
  `companyId === makeCompanyId(lead.careersUrl)`.
- `src/storage/repository.test.ts`: `companies.id` + `failed_leads.company_id` backfilled by
  `migrate()` on a pre-existing DB; legacy `postings.company_id` stays NULL without throwing;
  `savePosting` upsert carries `company_id` through on conflict.
- `src/cli/commands.test.ts`: retry-scoped feed filter keeps only needs-attention companyIds; a
  feed-recovered company is added to `attemptedUrls` and cleared; a NULL-companyId feed posting is
  not dropped on a `full` scan.
- `src/backend/postgres-mappers.test.ts`: `companyId` round-trips present and absent (nullable).
- `src/discovery/feed/posting-feed.test.ts`: a feed row missing `company_id` still validates and maps
  to `companyId: undefined` (the backward-compat window proof).

## Delivery

**One PR, both halves, deploy-sequenced.** The merge lands all code (local + worker + feed). The local
half works immediately on merge. The feed-scoping payoff activates after the manual §6 deploy runbook
is executed against the hosted worker/Supabase. The `FeedRow` nullish invariant must be called out
prominently in the PR for review.

## Explicit non-goals / flags

- Do NOT swap the `companies` PRIMARY KEY from `careers_url` to `id` (additive column only).
- Do NOT add `failed_leads` to Postgres or introduce worker-side failure tracking — feed-recovery
  clearing is client-side, reading `company_id` off feed postings.
- `postings.company_id` will have NULLs in production during the transition — every consumer treats
  NULL as "unknown, don't exclude."
- Postgres schema deploy is a manual `psql` step; sequence per §6 to avoid code-ahead-of-schema.
- `scans.id` / `profiles.id` are out of scope (non-portable, never cross stores).

## Success criteria

- `makeCompanyId` yields identical ids for the same normalized careers URL in both stores.
- New/re-crawled postings carry a correct `company_id` in both SQLite and Postgres.
- A scoped `--retry-failed` run filters the feed to needs-attention companies (after worker deploy).
- A company recovering via the feed is cleared from `failed_leads`.
- Feed rows without `company_id` (old worker) still validate and scan — no outage.
- Full CI-equivalent suite green; the Postgres worker's full-scan behavior is unchanged.

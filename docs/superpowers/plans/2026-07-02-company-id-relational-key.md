# Cross-store `companyId` Relational Key — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give companies a stable, content-derived `companyId` (identical in the local SQLite store and the hosted Postgres worker by construction) so postings and `failed_leads` reference companies unambiguously — unblocking feed-scoped `--retry-failed` runs and clearing feed-recovered companies.

**Architecture:** `companyId = sha256(normalizeCareersUrl(url)).slice(0,16)`, mirroring the existing `makePostingId`. Stamped onto postings in `discover()` (the one path both local scan and worker run). Additive schema columns in both stores; `companies.careers_url` stays the primary key. Feed postings carry `company_id` as a nullable column; the local retry path filters the feed by needs-attention companyIds and clears feed-recovered companies. Shipped as one PR; the worker/feed half activates after a manual `psql` deploy.

**Tech Stack:** TypeScript-strict ESM (ES2022), `better-sqlite3`, `postgres` (worker), Hono, Vitest, Zod, Biome.

## Global Constraints

- TypeScript-strict, ESM. NO `!` non-null assertions. NO type assertions (`as X`) outside test files.
- No new runtime dependencies.
- Biome: 2-space indent, 100-col width, double quotes. If `npm run lint` errors with an "ESLint output (JSON parse failed)" message (known harness quirk), lint via `./node_modules/.bin/biome check .` directly.
- Failures degrade, never crash: discovery/scoring collect `Warning`s and return partial results.
- Coverage gate (vitest.config.ts): statements 93 / branches 85 / functions 90 / lines 93. Keep green.
- Colocated `*.test.ts`, offline (DI + fixtures). Web tests jsdom + RTL; `fetch` mocked.
- **`companyId` is ALWAYS optional (`companyId?: string`) end-to-end.** Legacy DB rows and old-worker feed rows lack it. Every consumer treats NULL/undefined as "unknown — do not exclude," never "not a match."
- **`FeedRow.company_id` MUST stay `z.string().nullish()` (never required).** A required field turns an old-worker→new-client mismatch into a silent full-feed outage (zod fails → feed degrades to empty).
- Do NOT swap the `companies` PRIMARY KEY (it stays `careers_url`). Do NOT add `failed_leads` to Postgres.
- `scans.id`/`profiles.id` are out of scope.
- The Postgres schema deploy is a MANUAL `psql -f src/backend/schema.sql` step (no CI runner) — the ALTERs must be idempotent (`add column if not exists`).
- Conventional Commits. Do NOT add a Claude co-authored footer.
- Environment note: plain shell `grep` on working-tree files has spuriously returned empty in this repo — use `git grep` or Read/Grep tools. If files look wrong, `git branch --show-current` must be `feat/company-id-relational-key`.

**Shared helper introduced in Task 1, used throughout:**
```ts
// src/discovery/company-id.ts
export function makeCompanyId(careersUrl: string): string; // sha256(normalizeCareersUrl(url)).slice(0,16)
```

---

### Task 1: `makeCompanyId` helper

**Files:**
- Create: `src/discovery/company-id.ts`
- Test: `src/discovery/company-id.test.ts`

**Interfaces:**
- Consumes: `normalizeCareersUrl` from `src/domain/normalize.ts`.
- Produces: `makeCompanyId(careersUrl: string): string` — 16-char lowercase hex, deterministic on the normalized URL.

- [ ] **Step 1: Write the failing test**

Create `src/discovery/company-id.test.ts` (mirror `src/discovery/posting-id.test.ts`'s style):
```ts
import { describe, expect, it } from "vitest";
import { makeCompanyId } from "./company-id";

describe("makeCompanyId", () => {
  it("is a 16-char lowercase hex string", () => {
    const id = makeCompanyId("https://boards.greenhouse.io/acme");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic for the same URL", () => {
    const url = "https://boards.greenhouse.io/acme";
    expect(makeCompanyId(url)).toBe(makeCompanyId(url));
  });

  it("collapses URL variants that normalize to the same canonical form", () => {
    // normalizeCareersUrl lowercases, strips trailing slash, drops query/fragment.
    const canonical = makeCompanyId("https://boards.greenhouse.io/acme");
    expect(makeCompanyId("https://boards.greenhouse.io/acme/")).toBe(canonical);
    expect(makeCompanyId("https://Boards.Greenhouse.io/acme?utm=x")).toBe(canonical);
  });

  it("differs for genuinely different companies", () => {
    expect(makeCompanyId("https://boards.greenhouse.io/acme")).not.toBe(
      makeCompanyId("https://boards.greenhouse.io/other"),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/discovery/company-id.test.ts`
Expected: FAIL — `Cannot find module './company-id'`.

- [ ] **Step 3: Write the implementation**

Create `src/discovery/company-id.ts`:
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/discovery/company-id.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck` then `./node_modules/.bin/biome check .` (clean).
```bash
git add src/discovery/company-id.ts src/discovery/company-id.test.ts
git commit -m "feat(discovery): add makeCompanyId content-hash helper"
```

---

### Task 2: `JobPosting.companyId` + stamp in `discover()`

**Files:**
- Modify: `src/domain/types.ts` (add `companyId?: string` to `JobPosting`)
- Modify: `src/discovery/discover.ts` (stamp in both loops)
- Test: `src/discovery/discover.test.ts`

**Interfaces:**
- Consumes: `makeCompanyId` from Task 1.
- Produces: every posting returned by `discover()` carries `companyId = makeCompanyId(lead.careersUrl)`.

- [ ] **Step 1: Write the failing test**

In `src/discovery/discover.test.ts`, add (adapt the harness to the file's existing `discover()` test setup — the fake connector/lead injection it already uses):
```ts
it("stamps each posting with its company's companyId", async () => {
  const result = await discover(fakeDiscoverDeps({
    trackedCompanies: [{ careersUrl: "https://boards.greenhouse.io/acme", name: "Acme" }],
    // ...whatever makes the fake connector return >=1 posting for that lead
  }));
  const posting = result.postings[0];
  expect(posting?.companyId).toBe(makeCompanyId("https://boards.greenhouse.io/acme"));
});
```
Import `makeCompanyId` in the test. Match the file's actual fake-deps helper and connector-injection pattern; the assertion (posting.companyId === makeCompanyId(lead.careersUrl)) is fixed.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/discovery/discover.test.ts -t "stamps each posting with its company"`
Expected: FAIL — `posting.companyId` is `undefined` (not stamped yet).

- [ ] **Step 3a: Add the field to `JobPosting`**

In `src/domain/types.ts`, add to the `JobPosting` type (after `fetchedAt: Date;`):
```ts
  /** Stable id of the company this posting belongs to (hash of the company's normalized careers
   * URL). Optional: legacy DB rows and feed rows from an old worker lack it. */
  companyId?: string;
```

- [ ] **Step 3b: Stamp in both discover loops**

In `src/discovery/discover.ts`, add the import at the top:
```ts
import { makeCompanyId } from "./company-id";
```
In the MAIN-pass loop (where `for (const posting of result.postings) { byId.set(posting.id, posting); }` sits, ~lines 179-181), change to:
```ts
      for (const posting of result.postings) {
        byId.set(posting.id, { ...posting, companyId: makeCompanyId(lead.careersUrl) });
      }
```
In the RETRY-pass loop (the identical `for (const posting of result.postings)` block, ~lines 208-210), make the SAME change. Both loops have `lead` in scope (they destructure `{ lead, result }`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/discovery/discover.test.ts`
Expected: PASS (new test green; existing discover tests still green — adding an optional field doesn't break them).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck` then biome.
```bash
git add src/domain/types.ts src/discovery/discover.ts src/discovery/discover.test.ts
git commit -m "feat(discovery): stamp companyId on every discovered posting"
```

---

### Task 3: SQLite schema — `company_id`/`id` columns, migration, backfill, savePosting

**Files:**
- Modify: `src/storage/schema.ts` (add columns to base schema + index)
- Modify: `src/storage/repository.ts` (`migrate()` ALTER+backfill, `savePosting` upsert)
- Test: `src/storage/repository.test.ts`

**Interfaces:**
- Consumes: `makeCompanyId` from Task 1; `JobPosting.companyId` from Task 2.
- Produces: `companies.id`, `postings.company_id`, `failed_leads.company_id` in SQLite; `companies.id`/`failed_leads.company_id` backfilled on migrate; `savePosting` persists `posting.companyId`.

- [ ] **Step 1: Write the failing tests**

In `src/storage/repository.test.ts`, add a `describe("companyId columns", ...)` block. Match the file's existing on-disk-migration test pattern (the one that opens a legacy DB and runs `migrate()`):
```ts
it("backfills companies.id and failed_leads.company_id on migrate", () => {
  const repo = makeRepo();
  const scan = repo.startScan();
  repo.recordDirectory(scan, [{ careersUrl: "https://boards.greenhouse.io/acme", name: "Acme" }]);
  // seed a failed_leads row (5x per the threshold precedent used elsewhere in this file)
  for (let i = 0; i < 5; i++) {
    repo.recordScanFailures(
      repo.startScan(),
      [{ careersUrl: "https://boards.lever.co/boom", company: "Boom", message: "x" }],
      ["https://boards.lever.co/boom"],
    );
  }
  const companyRow = repo["db"]
    .prepare("SELECT id FROM companies WHERE careers_url = ?")
    .get("https://boards.greenhouse.io/acme") as { id: string };
  const leadRow = repo["db"]
    .prepare("SELECT company_id FROM failed_leads WHERE careers_url = ?")
    .get("https://boards.lever.co/boom") as { company_id: string };
  expect(companyRow.id).toBe(makeCompanyId("https://boards.greenhouse.io/acme"));
  expect(leadRow.company_id).toBe(makeCompanyId("https://boards.lever.co/boom"));
});

it("persists companyId on savePosting and leaves a companyId-less posting NULL", () => {
  const repo = makeRepo();
  const scan = repo.startScan();
  repo.savePosting({ ...makePosting({ id: "p1" }), companyId: "abc123def4567890" }, scan);
  repo.savePosting({ ...makePosting({ id: "p2" }) }, scan); // no companyId
  const p1 = repo["db"].prepare("SELECT company_id FROM postings WHERE id = ?").get("p1") as {
    company_id: string | null;
  };
  const p2 = repo["db"].prepare("SELECT company_id FROM postings WHERE id = ?").get("p2") as {
    company_id: string | null;
  };
  expect(p1.company_id).toBe("abc123def4567890");
  expect(p2.company_id).toBeNull();
});
```
Adapt `makeRepo`/`makePosting` to the file's real helpers; import `makeCompanyId`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/storage/repository.test.ts -t "companyId columns"`
Expected: FAIL — `no such column: id` / `company_id` (columns don't exist; savePosting doesn't bind companyId).

- [ ] **Step 3a: Add columns to the base schema**

In `src/storage/schema.ts`:
- `companies` table: add `id TEXT,` after `careers_url TEXT PRIMARY KEY,` (keep careers_url as PK).
- `postings` table: add `company_id TEXT,` (e.g. after `country TEXT,`).
- `failed_leads` table: add `company_id TEXT,` (e.g. after `company TEXT,`).
- In the `INDEXES` block add:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_id ON companies(id);
CREATE INDEX IF NOT EXISTS idx_postings_company_id ON postings(company_id);
```

- [ ] **Step 3b: Add the migration + backfill to `migrate()`**

In `src/storage/repository.ts` `migrate()`, following the existing `PRAGMA table_info` guard pattern, add guarded ALTERs (import `makeCompanyId` at the top of the file):
```ts
const companyColumns = new Set(
  (this.db.prepare("PRAGMA table_info(companies)").all() as { name: string }[]).map((c) => c.name),
);
if (!companyColumns.has("id")) {
  this.db.exec("ALTER TABLE companies ADD COLUMN id TEXT");
}
const postingCols2 = new Set(
  (this.db.prepare("PRAGMA table_info(postings)").all() as { name: string }[]).map((c) => c.name),
);
if (!postingCols2.has("company_id")) {
  this.db.exec("ALTER TABLE postings ADD COLUMN company_id TEXT");
}
const failedLeadCols = new Set(
  (this.db.prepare("PRAGMA table_info(failed_leads)").all() as { name: string }[]).map((c) => c.name),
);
if (!failedLeadCols.has("company_id")) {
  this.db.exec("ALTER TABLE failed_leads ADD COLUMN company_id TEXT");
}
```
Then backfill the two fully-derivable columns (run AFTER the ALTERs, still in `migrate()`, before the `INDEXES` exec — because the unique index on `companies.id` requires ids populated first):
```ts
const companiesNeedingId = this.db
  .prepare("SELECT careers_url FROM companies WHERE id IS NULL")
  .all() as { careers_url: string }[];
const setCompanyId = this.db.prepare("UPDATE companies SET id = ? WHERE careers_url = ?");
const backfillCompanies = this.db.transaction((rows: { careers_url: string }[]) => {
  for (const r of rows) setCompanyId.run(makeCompanyId(r.careers_url), r.careers_url);
});
backfillCompanies(companiesNeedingId);

const leadsNeedingId = this.db
  .prepare("SELECT careers_url FROM failed_leads WHERE company_id IS NULL")
  .all() as { careers_url: string }[];
const setLeadCompanyId = this.db.prepare("UPDATE failed_leads SET company_id = ? WHERE careers_url = ?");
const backfillLeads = this.db.transaction((rows: { careers_url: string }[]) => {
  for (const r of rows) setLeadCompanyId.run(makeCompanyId(r.careers_url), r.careers_url);
});
backfillLeads(leadsNeedingId);
```
NOTE: the unique index on `companies(id)` must be created AFTER this backfill (the `INDEXES` exec already runs at the end of `migrate()` — confirm ordering so the index sees populated ids; if `INDEXES` runs before this backfill, move the backfill above the `INDEXES` exec).

- [ ] **Step 3c: Persist companyId in `recordDirectory` and `savePosting`**

`companies.id` must be set on new company rows too (not just backfilled). In `recordDirectory` (`src/storage/repository.ts`), the `upsert` INSERT for companies gains `id`:
- Add `id` to the INSERT column list and `@id` to VALUES, and `id = excluded.id` is NOT needed (id is derived from careers_url which is the conflict key, so it never changes) — but DO include it in the INSERT so new rows get it. Compute `makeCompanyId(c.careersUrl)` when building the upsert params (the `companies` array is already normalized).

In `savePosting`, add `company_id` to the INSERT columns + `@companyId` value + the `ON CONFLICT DO UPDATE SET` clause (`company_id = excluded.company_id`), and bind `companyId: posting.companyId ?? null` in the `.run({...})` params object.

`recordScanFailures` (writes `failed_leads`) gains `company_id`: when upserting a failure row, set `company_id = makeCompanyId(careersUrl)` (careers_url is already normalized in that method).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/storage/repository.test.ts`
Expected: PASS (new tests green; existing repository tests green — additive columns, existing INSERTs still valid).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck` then biome.
```bash
git add src/storage/schema.ts src/storage/repository.ts src/storage/repository.test.ts
git commit -m "feat(storage): add companyId columns with migration backfill (SQLite)"
```

---

### Task 4: Feed-scope `--retry-failed` by companyId + clear feed-recovered companies

**Files:**
- Modify: `src/cli/commands.ts` (`SourceResult`, `sourceFromFeedAndTracked`, `SourcingDeps`, `runSourcing`, `runScan`)
- Test: `src/cli/commands.test.ts`

**Interfaces:**
- Consumes: `makeCompanyId` (Task 1); `JobPosting.companyId` (Task 2); `SourcingDeps.scope` (already exists from the merged scoped-scan work).
- Produces: on a `scope === "retry"` run, the feed is filtered to needs-attention companyIds, and companies recovering via the feed are added to `attemptedUrls` so `recordScanFailures` clears them.

- [ ] **Step 1: Write the failing tests**

In `src/cli/commands.test.ts` (the file testing `runScan`/`runSourcing` with a `FakePostingFeed`), add:
```ts
it("scopes the feed to needs-attention companyIds on a retry scan", async () => {
  const wantUrl = "https://boards.lever.co/boom";
  const otherUrl = "https://boards.greenhouse.io/acme";
  const feed = new FakePostingFeed({
    postings: [
      { ...makePosting({ id: "boom1" }), companyId: makeCompanyId(wantUrl) },
      { ...makePosting({ id: "acme1" }), companyId: makeCompanyId(otherUrl) },
    ],
    warnings: [],
  });
  // seed needsAttention with wantUrl only (5x recordScanFailures)
  seedNeedsAttention(repo, wantUrl);
  const outcome = await runSourcing({
    repo, feed, discoverDeps: fakeDiscoverDeps({ postings: [] }), scope: "retry",
    companyIdFilter: new Set([makeCompanyId(wantUrl)]),
  });
  const ids = outcome.postings.map((p) => p.id);
  expect(ids).toContain("boom1");
  expect(ids).not.toContain("acme1");
});

it("does not filter feed postings on a full scan", async () => {
  const feed = new FakePostingFeed({
    postings: [{ ...makePosting({ id: "acme1" }), companyId: makeCompanyId("https://x/y") }],
    warnings: [],
  });
  const outcome = await runSourcing({ repo, feed, discoverDeps: fakeDiscoverDeps({ postings: [] }) });
  expect(outcome.postings.map((p) => p.id)).toContain("acme1");
});
```
Add a second test asserting the feed-recovery clear (see Step 3). Adapt `seedNeedsAttention`/`fakeDiscoverDeps`/`makePosting` to the file's real helpers. The `companyIdFilter` param is new (Step 3).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/cli/commands.test.ts -t "scopes the feed to needs-attention"`
Expected: FAIL — `runSourcing` doesn't accept `companyIdFilter`; the feed isn't filtered.

- [ ] **Step 3a: Thread `companyIdFilter` and return `recoveredFromFeed`**

In `src/cli/commands.ts`:
- Add `companyIdFilter?: Set<string>` to `SourcingDeps` (the `scope?: ScanScope` field is already there).
- Extend `SourceResult` (the `{ postings; companies; warnings }` type) with `recoveredFromFeed?: CompanyRef[]`.
- In `sourceFromFeedAndTracked(feed, discoverDeps, onProgress, companyIdFilter?)`: after `feedResult = await feed.fetch()`, filter when a filter is present:
```ts
  const feedPostings = companyIdFilter
    ? feedResult.postings.filter((p) => p.companyId !== undefined && companyIdFilter.has(p.companyId))
    : feedResult.postings;
```
Then merge `feedPostings` (not `feedResult.postings`) into `byId`.
- Compute `recoveredFromFeed`: the needs-attention companies whose companyId appeared in `feedPostings`. Since `sourceFromFeedAndTracked` doesn't hold the needs-attention list, pass it what it needs — thread `recoverFromFeed?: CompanyRef[]` (the needs-attention CompanyRefs) into it too, and return those whose `makeCompanyId(careersUrl)` is in `new Set(feedPostings.map(p => p.companyId))`. (Simpler alternative: return the set of companyIds seen in `feedPostings` and let `runSourcing`/`runScan` map back to careersUrls — pick whichever keeps types cleanest; the REQUIREMENT is `runScan` can learn which needs-attention careersUrls recovered via the feed.)
- In `runSourcing`, pass `companyIdFilter` and the needs-attention CompanyRefs through to `sourceFromFeedAndTracked`, and surface `recoveredFromFeed` on `SourcingOutcome`.

- [ ] **Step 3b: Compute the filter and union recovered URLs in `runScan` + callers**

In `runScan` (`src/cli/commands.ts`), when `scope === "retry"`, build the filter from the needs-attention list the caller already has. The needs-attention companies are available via `repo.listNeedsAttention()`; compute `companyIdFilter = new Set(needsAttention.map(c => makeCompanyId(c.careersUrl)))` and pass it into `runSourcing`. After scoring, when building `attemptedUrls` for `recordScanFailures`, union in `sourced.recoveredFromFeed?.map(c => c.careersUrl) ?? []`:
```ts
const attemptedUrls = [
  ...sourced.companies.map((c) => c.careersUrl),
  ...(sourced.recoveredFromFeed ?? []).map((c) => c.careersUrl),
];
repo.recordScanFailures(sourced.scanId, perCompanyFailures, attemptedUrls);
```
The two scoped entry points (`runScanCommand` in `main.ts`, `createRetryFailedScanRunner` in `scan-runner.ts`) already pass `scope: "retry"`; they need no change if `runScan` derives the filter from `repo.listNeedsAttention()` internally. (Prefer deriving inside `runScan` so both entry points get it for free.)

- [ ] **Step 3c: Add the feed-recovery clear test**

```ts
it("clears a feed-recovered company from failed_leads", async () => {
  const url = "https://boards.lever.co/boom";
  seedNeedsAttention(repo, url); // consecutive_failures >= 5
  const feed = new FakePostingFeed({
    postings: [{ ...makePosting({ id: "boom1" }), companyId: makeCompanyId(url) }],
    warnings: [],
  });
  await runScan(
    { repo, profile, scorer, feed, discoverDeps: fakeDiscoverDeps({ postings: [] }), scope: "retry" },
    () => {},
  );
  // recovered via feed → removed from failed_leads → no longer in needs-attention
  expect(repo.listNeedsAttention().map((c) => c.careersUrl)).not.toContain(url);
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/commands.test.ts`
Expected: PASS (all new tests green; existing full-scan + local-retry tests green).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck` then biome.
```bash
git add src/cli/commands.ts src/cli/commands.test.ts
git commit -m "feat(cli): scope feed by companyId and clear feed-recovered companies on retry"
```

---

### Task 5: Update the `--retry-failed` feed-limitation docs

**Files:**
- Modify: `src/cli/main.ts` (the comment documenting the feed-scoping limitation) and `src/cli/help.ts` (the `--retry-failed` help text noting the feed caveat).

**Interfaces:** none (docs only).

- [ ] **Step 1: Update the limitation comment in `main.ts`**

The scoped-scan work left a comment in `runScanCommand` (and help text) saying the feed is pulled whole in retry mode. Now that Task 4 scopes it, update that comment to reflect the new behavior: the feed IS scoped by companyId when the worker emits `company_id`; feed postings from an old worker (no companyId) fall back to being excluded from the scoped set. Find the comment via `git grep -n "shared feed is still pulled" HEAD -- src/cli/main.ts` and rewrite it accurately.

- [ ] **Step 2: Update the help text in `help.ts`**

Find the `--retry-failed` option text (`git grep -n "retry-failed" HEAD -- src/cli/help.ts`) and update the feed caveat to: the feed is scoped to needs-attention companies once the shared worker emits company ids.

- [ ] **Step 3: Run the CLI help/parse tests, lint, commit**

Run: `npx vitest run src/cli/help.test.ts src/cli/parse.test.ts` (Expected: PASS — if these tests assert on help substrings, update the assertions to match the new text). Then biome.
```bash
git add src/cli/main.ts src/cli/help.ts src/cli/help.test.ts
git commit -m "docs(cli): update --retry-failed feed-scoping notes"
```

---

### Task 6: Postgres worker — schema + mappers + store carry `company_id`

**Files:**
- Modify: `src/backend/schema.sql` (idempotent ALTERs + indexes)
- Modify: `src/backend/postgres-mappers.ts` (`PostingRow`, `PostingInsert`, `postingToRow`, `rowToPosting`)
- Modify: `src/backend/postgres-scan-store.ts` (`savePosting`, `savePostings`, `recordDirectory` companies.id)
- Test: `src/backend/postgres-mappers.test.ts`

**Interfaces:**
- Consumes: `JobPosting.companyId` (Task 2), `makeCompanyId` (Task 1).
- Produces: the worker persists `postings.company_id` and `companies.id`; the mappers round-trip `companyId`.

- [ ] **Step 1: Write the failing mapper test**

In `src/backend/postgres-mappers.test.ts`, extend the round-trip test:
```ts
it("round-trips companyId, and maps a null company_id to undefined", () => {
  const withId = postingToRow({ ...makePosting({ id: "a" }), companyId: "abc123def4567890" });
  expect(withId.company_id).toBe("abc123def4567890");
  const back = rowToPosting({ ...withId, company_id: "abc123def4567890" } as PostingRow);
  expect(back.companyId).toBe("abc123def4567890");
  const noId = rowToPosting({ ...withId, company_id: null } as PostingRow);
  expect(noId.companyId).toBeUndefined();
});
```
Match the file's `makePosting`/existing round-trip test idiom.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/backend/postgres-mappers.test.ts -t "round-trips companyId"`
Expected: FAIL — `company_id`/`companyId` not on the types/mappers.

- [ ] **Step 3a: Update the mappers**

In `src/backend/postgres-mappers.ts`:
- `PostingRow`: add `company_id: string | null;`
- `PostingInsert`: add `company_id: string | null;`
- `postingToRow`: add `company_id: posting.companyId ?? null,`
- `rowToPosting`: add `...(row.company_id ? { companyId: row.company_id } : {}),` (following the `location`/`country` optional pattern).

- [ ] **Step 3b: Update the Postgres store**

In `src/backend/postgres-scan-store.ts`:
- `savePosting` (single-row INSERT): add `company_id` to the column list, the values, and the `ON CONFLICT (id) DO UPDATE SET company_id = excluded.company_id`.
- `savePostings` (bulk): add `company_id` to the `columns` array and the conflict-update set.
- `recordDirectory`: the companies upsert INSERT gains `id` (compute `makeCompanyId(careers_url)` per row; import `makeCompanyId`). Add `import { makeCompanyId } from "@app/discovery/company-id";`.
- The `SELECT` in the store's posting reads (e.g. `listLivePostingsNotSeen`) that map through `rowToPosting`: add `company_id` to the selected columns so the field round-trips.

- [ ] **Step 3c: Append idempotent Postgres schema ALTERs**

At the bottom of `src/backend/schema.sql` (matching the existing `add column if not exists` convention):
```sql
alter table companies add column if not exists id text;
create unique index if not exists companies_id_idx on companies (id);
alter table postings add column if not exists company_id text;
create index if not exists postings_company_id_idx on postings (company_id);
```

- [ ] **Step 4: Run test to verify it passes + full suite**

Run: `npx vitest run src/backend/postgres-mappers.test.ts` (Expected: PASS). The store methods are integration-bound (real Postgres) and not unit-tested here — `npm run typecheck` covers their compilation.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck` then biome.
```bash
git add src/backend/schema.sql src/backend/postgres-mappers.ts src/backend/postgres-scan-store.ts src/backend/postgres-mappers.test.ts
git commit -m "feat(backend): carry companyId through the Postgres worker and schema"
```

---

### Task 7: Feed contract — `company_id` column, nullish, backward compat

**Files:**
- Modify: `src/discovery/feed/posting-feed.ts` (`FeedRow`, `COLUMNS`, `rowToPosting` call)
- Test: `src/discovery/feed/posting-feed.test.ts`

**Interfaces:**
- Consumes: `JobPosting.companyId` (Task 2).
- Produces: the feed reads `company_id` when present; a feed row WITHOUT it validates and maps to `companyId: undefined`.

- [ ] **Step 1: Write the failing tests**

In `src/discovery/feed/posting-feed.test.ts` (create if absent; if absent, mirror the DI + fake-fetcher pattern the repo uses for `HttpPostingFeed` — inject a `Fetcher` returning a canned JSON body):
```ts
it("maps a feed row's company_id to companyId", async () => {
  const fetcher = fakeFetcherReturning([
    { id: "a", company: "Acme", title: "T", url: "u", source: "s", description: "d",
      fetched_at: "2026-07-02T00:00:00Z", company_id: "abc123def4567890" },
  ]);
  const feed = new HttpPostingFeed({ fetcher, baseUrl: "https://x", apiKey: "k" });
  const { postings } = await feed.fetch();
  expect(postings[0]?.companyId).toBe("abc123def4567890");
});

it("validates and maps a feed row that lacks company_id (old worker) to undefined", async () => {
  const fetcher = fakeFetcherReturning([
    { id: "a", company: "Acme", title: "T", url: "u", source: "s", description: "d",
      fetched_at: "2026-07-02T00:00:00Z" }, // no company_id
  ]);
  const feed = new HttpPostingFeed({ fetcher, baseUrl: "https://x", apiKey: "k" });
  const result = await feed.fetch();
  expect(result.warnings).toEqual([]); // did NOT degrade to an empty warning result
  expect(result.postings[0]?.companyId).toBeUndefined();
});
```
Adapt `fakeFetcherReturning` to how the repo fakes a `Fetcher` (check `fetch-feed`'s existing tests). The SECOND test is the backward-compat-window proof and is the most important one.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/discovery/feed/posting-feed.test.ts`
Expected: FAIL — `companyId` is undefined even when `company_id` is present (not mapped yet).

- [ ] **Step 3: Update the feed contract**

In `src/discovery/feed/posting-feed.ts`:
- Add `company_id: z.string().nullish(),` to the `FeedRow` zod object. **MUST be `.nullish()`, never required** — a required field would fail validation on old-worker rows and silently zero the entire feed.
- Add `company_id` to the `COLUMNS` string.
- In the `rowToPosting({...})` mapping call, add `company_id: r.company_id ?? null,`.

- [ ] **Step 4: Run tests to verify they pass + full suite**

Run: `npx vitest run src/discovery/feed/posting-feed.test.ts` (Expected: PASS, both tests). Then `npm test` to confirm nothing else regressed.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck` then biome.
```bash
git add src/discovery/feed/posting-feed.ts src/discovery/feed/posting-feed.test.ts
git commit -m "feat(feed): carry companyId through the shared feed (nullish, back-compat safe)"
```

---

### Task 8: Deploy runbook doc

**Files:**
- Create: `docs/company-id-deploy-runbook.md`

**Interfaces:** none (docs).

- [ ] **Step 1: Write the runbook**

Create `docs/company-id-deploy-runbook.md` documenting the coordinated manual deploy (no CI runner):
```markdown
# companyId — Worker/Feed Deploy Runbook

The local half (SQLite companyId + local retry scoping) works on merge. The feed-scoping payoff
activates only after the hosted worker emits `company_id`. Steps, in order:

1. Apply the additive schema to Supabase:
   `psql "$DATABASE_URL" -f src/backend/schema.sql`  (idempotent `add column if not exists`).
2. Backfill existing `companies.id` (run once, uses the same makeCompanyId as the app):
   `npm run backfill:company-id`  (see script below) — or run the equivalent one-off node script.
3. Deploy + run the worker (`npm run scan:worker`) at least once (ideally twice) so feed `postings`
   rows start carrying `company_id`.
4. The local client changes ship in the same PR; retry feed-scoping activates automatically once the
   feed emits `company_id`. Until then it degrades to local-crawl-only scoping (no crash).

Ordering note: shipping the client before the worker is SAFE (FeedRow.company_id is nullish) —
retry feed-scoping simply no-ops until the worker catches up. Never make FeedRow.company_id required.
```
If a `backfill:company-id` script is warranted, note it as a follow-up rather than building it here unless trivial — the SQLite backfill runs automatically in `migrate()`; only Postgres needs the one-off. Keep this task doc-only; do not add the Postgres backfill script unless Task 6 already needed it (it doesn't for correctness — new company rows get `id` via `recordDirectory`, and feed-scoping tolerates NULL).

- [ ] **Step 2: Commit**

```bash
git add docs/company-id-deploy-runbook.md
git commit -m "docs: companyId worker/feed deploy runbook"
```

---

### Task 9: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full CI-equivalent suite**

```bash
./node_modules/.bin/biome check .
npm run typecheck
npm run typecheck:web
npm run test:coverage
npm run test:web
npm run build:web
```
Expected: lint clean (only the pre-existing `biome.json` info); both typechecks clean; `test:coverage` passes with the gate green (≥93/85/90/93); `test:web` green; `build:web` clean.

- [ ] **Step 2: Confirm the local half is self-contained**

Verify (read, don't guess) that nothing in the LOCAL path (SQLite `Repository`, `discover`, `runScan`) requires the Postgres `company_id` column to exist — the local half works before the manual worker deploy. Note in the ledger.

---

### Task 10: Whole-branch review + PR

**Files:** none (review + integration).

- [ ] **Step 1: Rebase onto latest main**

```bash
git fetch origin main
git branch -f backup/company-id-pre-rebase HEAD
git rebase origin/main
```
Resolve conflicts if any; re-run the full suite from Task 9 Step 1 after a clean rebase.

- [ ] **Step 2: Whole-branch review**

Run the whole-branch review on the most capable model over the full branch diff (`git merge-base main HEAD`..HEAD), pointing it at the spec (`docs/superpowers/specs/2026-07-02-company-id-relational-key-design.md`). Emphasize the two highest-risk invariants: (a) `FeedRow.company_id` stays `z.nullish()`; (b) every consumer treats NULL/undefined companyId as "unknown, don't exclude." Dispatch ONE fix subagent with the complete findings list if any Critical/Important survive; re-verify.

- [ ] **Step 3: Staff-eng pre-flight**

Run the staff-eng pre-flight lens over the rebased diff (dimension 0 anti-pattern catalog first, then 1-6). Record the sentinel only on a READY verdict.

- [ ] **Step 4: Open the PR**

After explicit user go-ahead (externally-visible mutation): push the branch and `gh pr create` against `main`. PR body must (a) summarize the companyId relational key + feed-scoping payoff, (b) prominently call out the manual deploy runbook (`docs/company-id-deploy-runbook.md`) and that feed-scoping activates only after the worker redeploy, (c) flag the `FeedRow` nullish invariant for reviewers, (d) note the full-suite evidence. No Claude co-authored footer.

---

## Notes for the implementer

- **`git grep` over shell `grep`:** plain `grep` on working-tree files has returned empty spuriously in this repo; use `git grep` or the Read/Grep tools.
- **Watch for unexpected `main` checkouts:** this repo's working tree has been found checked out to `main` mid-session before. If files look wrong, `git branch --show-current` must be `feat/company-id-relational-key`; recover with `git checkout feat/company-id-relational-key`.
- **Adapt test doubles to each file's existing fakes** (`makeRepo`, `makePosting`, `fakeDiscoverDeps`, `FakePostingFeed`, `seedNeedsAttention` = 5× `recordScanFailures`). The sketches name helpers generically; use the file's real ones. The assertions are fixed; the plumbing follows the file.
- **The NULL-companyId invariant is the subtle correctness point** — a retry filter excludes a posting whose companyId isn't in the set (including undefined), but a `full` scan never filters. Test both.
- **Never make `FeedRow.company_id` required.** This is the single highest-risk line in the change.

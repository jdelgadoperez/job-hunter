# Scoped-Scan Mode for `--retry-failed` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a scoped `--retry-failed` scan refresh only the companies it crawls — never running full-directory bookkeeping (removed-diff, liveness re-check, expiry) as if it saw the whole directory — and fix two adjacent retry-machinery bugs.

**Architecture:** Thread a `scope: "full" | "retry"` through `runSourcing` (default `"full"`, so normal `scan` and the hosted Postgres worker are byte-for-byte unchanged). A `"retry"` scope skips the removed-diff, liveness re-check, and expiry, while still upserting/stamping the crawled postings. The staleness clock becomes full-scan-count-based (a new `scans.kind` column) so scoped runs never advance it. Separately, the in-run retry pass reuses the main pass's concurrency+politeness scheduler, and the dashboard invalidates the needs-attention query on scan completion.

**Tech Stack:** TypeScript-strict ESM, `better-sqlite3`, Hono, Vitest, React 19 + TanStack Query, Biome.

## Global Constraints

- TypeScript-strict, ESM, `target` ES2022. NO `!` non-null assertions. NO type assertions (`as X`) outside test files.
- No new runtime dependencies.
- Biome: 2-space indent, 100-col width, double quotes. If `npm run lint` errors with an "ESLint output (JSON parse failed)" message (known harness quirk), lint via `./node_modules/.bin/biome check .` directly.
- Failures degrade, never crash: discovery/scoring collect `Warning`s and return partial results; a single company or failed call must never abort a scan.
- Coverage gate (vitest.config.ts): statements 93 / branches 85 / functions 90 / lines 93. Keep green.
- Tests are colocated (`*.test.ts` next to source), offline by design (DI + fixtures). Web tests run under jsdom + RTL via `npm run test:web`; `fetch` is mocked.
- The shared `ScanStore` seam (`src/discovery/scan-store.ts`) is consumed by the hosted Postgres worker (`src/backend/scanner/run-once.ts`, `PostgresScanStore`). Every interface change here MUST be optional and default to full-scan behavior so the worker is behaviorally unchanged.
- The `web/src/api.ts` zod schemas are the client/server contract.
- Conventional Commits. Do NOT add a Claude co-authored footer.

**Shared type introduced in Task 1, used throughout:**
```ts
export type ScanScope = "full" | "retry";
```

---

### Task 1: `ScanScope` type + `scans.kind` column + `startScan(kind)`

Adds the scan-kind concept: a shared `ScanScope` type, an additive `scans.kind` column with an idempotent migration, and a `startScan` that records the kind. No behavior change yet — full scans default to `"full"`.

**Files:**
- Modify: `src/discovery/scan-store.ts` (add `ScanScope` export; widen `startScan` signature)
- Modify: `src/storage/schema.ts` (base-schema `kind` column so fresh DBs have it)
- Modify: `src/storage/repository.ts` (migration + `startScan(kind)`)
- Test: `src/storage/repository.test.ts`

**Interfaces:**
- Produces: `export type ScanScope = "full" | "retry"` in `src/discovery/scan-store.ts`.
- Produces: `Repository.startScan(kind: ScanScope = "full"): number` — records the kind in the `scans` row.
- Produces: `ScanStore.startScan(kind?: ScanScope): number | Promise<number>` (optional param, default `"full"`).

- [ ] **Step 1: Add the `ScanScope` type to the scan-store seam**

In `src/discovery/scan-store.ts`, near the top (after the existing imports), add:
```ts
/** Whether a scan crawled the whole directory (`"full"`) or only a scoped subset (`"retry"`). */
export type ScanScope = "full" | "retry";
```

- [ ] **Step 2: Write the failing test for `startScan` recording the kind**

In `src/storage/repository.test.ts`, add (match the existing style — open a temp/in-memory `Repository`, query the `scans` table directly):
```ts
it("records the scan kind, defaulting to full", () => {
  const repo = makeRepo(); // however the file constructs a Repository in other tests
  const fullId = repo.startScan();
  const retryId = repo.startScan("retry");
  const rows = repo.rawScansForTest?.() ?? null; // if no helper exists, query inline below
  const kindOf = (id: number) =>
    (
      repo["db"].prepare("SELECT kind FROM scans WHERE id = ?").get(id) as { kind: string }
    ).kind;
  expect(kindOf(fullId)).toBe("full");
  expect(kindOf(retryId)).toBe("retry");
});
```
If the test file already has a canonical way to reach the raw DB (many tests do `repo["db"]` or a helper), use that instead of the inline `kindOf` — keep it consistent with neighbors. Do not add a production `rawScansForTest` helper; query the DB from the test.

- [ ] **Step 3: Run the test — verify it fails**

Run: `npx vitest run src/storage/repository.test.ts -t "records the scan kind"`
Expected: FAIL — either `startScan` rejects the argument (type error surfaces at typecheck) or the `kind` column doesn't exist (`no such column: kind`).

- [ ] **Step 4: Add `kind` to the base schema**

In `src/storage/schema.ts`, in the `CREATE TABLE IF NOT EXISTS scans (...)` block, add the column (so fresh databases have it without relying on the migration):
```sql
CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  postings_seen INTEGER,
  companies_seen INTEGER,
  new_companies TEXT,
  removed_companies TEXT,
  kind TEXT NOT NULL DEFAULT 'full'
);
```

- [ ] **Step 5: Add the idempotent migration for existing databases**

In `src/storage/repository.ts`, inside `migrate()`, following the existing `PRAGMA table_info` pattern, add a `scans`-column guard (place it after the `match_results` block, before the `INDEXES` exec):
```ts
const scanColumns = new Set(
  (this.db.prepare("PRAGMA table_info(scans)").all() as { name: string }[]).map((c) => c.name),
);
if (!scanColumns.has("kind")) {
  this.db.exec("ALTER TABLE scans ADD COLUMN kind TEXT NOT NULL DEFAULT 'full'");
}
```

- [ ] **Step 6: Update `startScan` to record the kind**

In `src/storage/repository.ts`, replace the current `startScan`:
```ts
  /** Open a new scan run and return its sequential id (drives the diff + posting expiry). */
  startScan(): number {
    const info = this.db.prepare("INSERT INTO scans (started_at) VALUES (datetime('now'))").run();
    return Number(info.lastInsertRowid);
  }
```
with:
```ts
  /** Open a new scan run of the given `kind` and return its sequential id (drives the diff +
   * posting expiry). A `"retry"` scan is a scoped rescan and is excluded from the staleness clock
   * that `expireStalePostings` reads (see there). */
  startScan(kind: ScanScope = "full"): number {
    const info = this.db
      .prepare("INSERT INTO scans (started_at, kind) VALUES (datetime('now'), ?)")
      .run(kind);
    return Number(info.lastInsertRowid);
  }
```
Add `ScanScope` to the imports at the top of `repository.ts`:
```ts
import type { ScanScope } from "@app/discovery/scan-store";
```
(If `repository.ts` already imports other things from `@app/discovery/scan-store`, add `ScanScope` to that import instead.)

- [ ] **Step 7: Widen the `ScanStore.startScan` signature**

In `src/discovery/scan-store.ts`, change:
```ts
  startScan(): number | Promise<number>;
```
to:
```ts
  startScan(kind?: ScanScope): number | Promise<number>;
```
The Postgres store never passes a kind, so it keeps defaulting to `"full"` — no worker change required.

- [ ] **Step 8: Run the test — verify it passes, plus the full storage suite**

Run: `npx vitest run src/storage/repository.test.ts`
Expected: PASS (new test green, all existing repository tests still green).

- [ ] **Step 9: Typecheck + lint + commit**

Run: `npm run typecheck` (clean — confirms the `ScanStore` widening didn't break `run-once.ts` / `PostgresScanStore`), then `./node_modules/.bin/biome check .` (clean).
```bash
git add src/discovery/scan-store.ts src/storage/schema.ts src/storage/repository.ts src/storage/repository.test.ts
git commit -m "feat(storage): record scan kind (full vs retry) to support scoped scans"
```

---

### Task 2: Full-scan-count staleness in `expireStalePostings`

Change `expireStalePostings` to measure staleness in **full scans elapsed** since a posting's `last_seen_scan`, so scoped (`"retry"`) scans never push a healthy posting toward expiry. Full-scan semantics are unchanged (a posting last seen on full scan *N* still expires after two more full scans).

**Files:**
- Modify: `src/storage/repository.ts` (`expireStalePostings` query)
- Test: `src/storage/repository.test.ts`

**Interfaces:**
- Consumes: `scans.kind` column and `startScan(kind)` from Task 1.
- Produces: `expireStalePostings(currentScanId: number, staleAfter = 2): number` — same signature, staleness now counts full scans strictly newer than `last_seen_scan`.

- [ ] **Step 1: Write the failing test — scoped scans don't advance the expiry clock**

In `src/storage/repository.test.ts`, add. Derive expectations from the seeded scan sequence, not hardcoded ids:
```ts
it("counts only full scans toward staleness, so retry scans never expire healthy postings", () => {
  const repo = makeRepo();
  // Full scan #1: a healthy posting is seen.
  const scan1 = repo.startScan("full");
  repo.savePosting(makePosting({ id: "p1" }), scan1); // use the file's posting factory
  // Two scoped retry scans happen (e.g. the user iterates on flaky companies).
  repo.startScan("retry");
  repo.startScan("retry");
  // Even though the raw scanId gap is now >= 2, only 0 FULL scans have elapsed since scan1,
  // so nothing is stale.
  expect(repo.expireStalePostings(repo.startScan("retry"))).toBe(0);
  // A genuine second AND third full scan (that don't re-see p1) DO make it stale.
  repo.startScan("full");
  const laterFull = repo.startScan("full");
  expect(repo.expireStalePostings(laterFull)).toBe(1);
});
```
Adapt `makeRepo`/`makePosting`/`savePosting` to the file's actual helpers and posting-save signature (`savePosting(posting, scanId)`), matching existing expiry tests in the file.

- [ ] **Step 2: Run the test — verify it fails**

Run: `npx vitest run src/storage/repository.test.ts -t "counts only full scans toward staleness"`
Expected: FAIL — under the current raw-`scanId`-gap query the first `expireStalePostings` call expires `p1` (returns 1, not 0), because two retry scans inflated the gap.

- [ ] **Step 3: Rewrite the `expireStalePostings` query to count full scans**

In `src/storage/repository.ts`, replace:
```ts
  expireStalePostings(currentScanId: number, staleAfter = 2): number {
    return this.db
      .prepare(
        `UPDATE postings SET expired_at = datetime('now')
         WHERE expired_at IS NULL AND last_seen_scan IS NOT NULL
           AND (? - last_seen_scan) >= ?`,
      )
      .run(currentScanId, staleAfter).changes;
  }
```
with:
```ts
  /** Expire postings not re-seen for `staleAfter` **full** scans. Staleness counts only full scans
   * newer than a posting's `last_seen_scan`, so any number of scoped `"retry"` scans in between
   * never advances the clock (a scoped run refreshes only the companies it crawls). */
  expireStalePostings(currentScanId: number, staleAfter = 2): number {
    return this.db
      .prepare(
        `UPDATE postings SET expired_at = datetime('now')
         WHERE expired_at IS NULL AND last_seen_scan IS NOT NULL
           AND (
             SELECT COUNT(*) FROM scans
             WHERE kind = 'full' AND id > postings.last_seen_scan AND id <= ?
           ) >= ?`,
      )
      .run(currentScanId, staleAfter).changes;
  }
```
Note the `id <= ?` bound: staleness is measured up to and including the current scan, matching the old `currentScanId - last_seen_scan` semantics (a posting seen on the current scan has 0 newer full scans → never expired).

- [ ] **Step 4: Run the test — verify it passes, plus the full storage suite**

Run: `npx vitest run src/storage/repository.test.ts`
Expected: PASS. If a pre-existing expiry test seeded scans via `startScan()` without a kind, it still works (kind defaults to `"full"`), so those tests stay green. If any pre-existing test relied on the raw-gap counting *non-full* scans, update it to seed `"full"` scans — the full-scan path is the one being preserved.

- [ ] **Step 5: Typecheck + lint + commit**

Run: `npm run typecheck` then `./node_modules/.bin/biome check .` (both clean).
```bash
git add src/storage/repository.ts src/storage/repository.test.ts
git commit -m "fix(storage): count only full scans toward posting staleness"
```

---

### Task 3: Scope-aware `recordDirectory` (skip removed-diff on retry)

Let `recordDirectory` skip the removed-companies computation on a scoped run while still upserting the crawled companies (so their `last_seen_scan` advances). This fixes the "whole directory reported gone" bug.

**Files:**
- Modify: `src/discovery/scan-store.ts` (`recordDirectory` signature — add optional options)
- Modify: `src/storage/repository.ts` (`recordDirectory` implementation)
- Test: `src/storage/repository.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `recordDirectory(scanId: number, companies: CompanyRef[], options?: { computeRemoved?: boolean }): DirectoryDiff` — `computeRemoved` defaults to `true` (current behavior). When `false`, `removedCompanies` and `newCompanies` are both `[]`, but companies are still upserted.

- [ ] **Step 1: Write the failing test — retry-scope recordDirectory reports no removals**

In `src/storage/repository.test.ts`, add. Seed a full scan with two companies, then a second scan that "sees" only one of them but with `computeRemoved: false`:
```ts
it("does not report removed companies when computeRemoved is false", () => {
  const repo = makeRepo();
  const scan1 = repo.startScan("full");
  repo.recordDirectory(scan1, [
    { careersUrl: "https://a.example/careers" },
    { careersUrl: "https://b.example/careers" },
  ]);
  const scan2 = repo.startScan("retry");
  const diff = repo.recordDirectory(
    scan2,
    [{ careersUrl: "https://a.example/careers" }],
    { computeRemoved: false },
  );
  expect(diff.removedCompanies).toEqual([]);
  expect(diff.newCompanies).toEqual([]);
  // But company A was still upserted/refreshed this scan (last_seen_scan advanced).
  const a = repo["db"]
    .prepare("SELECT last_seen_scan FROM companies WHERE careers_url = ?")
    .get("https://a.example/careers") as { last_seen_scan: number };
  expect(a.last_seen_scan).toBe(scan2);
});
```
Match the file's DB-access idiom for the last assertion.

- [ ] **Step 2: Run the test — verify it fails**

Run: `npx vitest run src/storage/repository.test.ts -t "does not report removed companies"`
Expected: FAIL — `recordDirectory` currently takes no options (type/arg error), and once the arg is accepted, the default path would report B as removed.

- [ ] **Step 3: Update the `ScanStore.recordDirectory` signature**

In `src/discovery/scan-store.ts`, change:
```ts
  recordDirectory(scanId: number, companies: CompanyRef[]): DirectoryDiff | Promise<DirectoryDiff>;
```
to:
```ts
  recordDirectory(
    scanId: number,
    companies: CompanyRef[],
    options?: { computeRemoved?: boolean },
  ): DirectoryDiff | Promise<DirectoryDiff>;
```
Optional options → the Postgres worker (which calls it with two args for full scans) is unchanged.

- [ ] **Step 4: Implement `computeRemoved` in `recordDirectory`**

In `src/storage/repository.ts`, change the method signature:
```ts
  recordDirectory(
    scanId: number,
    companiesIn: CompanyRef[],
  ): { newCompanies: CompanyRef[]; removedCompanies: CompanyRef[] } {
```
to:
```ts
  recordDirectory(
    scanId: number,
    companiesIn: CompanyRef[],
    options: { computeRemoved?: boolean } = {},
  ): { newCompanies: CompanyRef[]; removedCompanies: CompanyRef[] } {
    const computeRemoved = options.computeRemoved ?? true;
```
Then, where `newCompanies` / `removedCompanies` are computed, short-circuit when `computeRemoved` is false. Replace:
```ts
    const newCompanies = isBaseline ? [] : companies.filter((c) => !existingUrls.has(c.careersUrl));
    const removedCompanies =
      isBaseline || prevScan === null
        ? []
        : existing
            .filter((e) => e.last_seen_scan === prevScan && !currentUrls.has(e.careers_url))
            .map((e) => ({ careersUrl: e.careers_url, ...(e.name ? { name: e.name } : {}) }));
```
with:
```ts
    const newCompanies =
      !computeRemoved || isBaseline
        ? []
        : companies.filter((c) => !existingUrls.has(c.careersUrl));
    const removedCompanies =
      !computeRemoved || isBaseline || prevScan === null
        ? []
        : existing
            .filter((e) => e.last_seen_scan === prevScan && !currentUrls.has(e.careers_url))
            .map((e) => ({ careersUrl: e.careers_url, ...(e.name ? { name: e.name } : {}) }));
```
The `upsertMany(companies)` call below stays unchanged — crawled companies are always upserted, regardless of `computeRemoved`.

- [ ] **Step 5: Run the test — verify it passes, plus the full storage suite**

Run: `npx vitest run src/storage/repository.test.ts`
Expected: PASS (new test green; existing `recordDirectory` tests still green since `computeRemoved` defaults to `true`).

- [ ] **Step 6: Typecheck + lint + commit**

Run: `npm run typecheck` then `./node_modules/.bin/biome check .` (both clean).
```bash
git add src/discovery/scan-store.ts src/storage/repository.ts src/storage/repository.test.ts
git commit -m "feat(storage): let recordDirectory skip the removed-diff for scoped scans"
```

---

### Task 4: Thread `scope` through `runSourcing` (skip recheck + expiry on retry)

Add `scope` to `SourcingDeps` and make `runSourcing` skip liveness re-check and expiry on a `"retry"` scan, pass `computeRemoved: false` to `recordDirectory`, and open the scan as `"retry"`. This is the core wiring that fixes the liveness-sweep and directory-diff bugs at the sourcing layer.

**Files:**
- Modify: `src/cli/commands.ts` (`SourcingDeps` type; `runSourcing` body)
- Test: `src/cli/commands.test.ts`

**Interfaces:**
- Consumes: `startScan(kind)`, `recordDirectory(..., { computeRemoved })` from Tasks 1 & 3; `ScanScope` from Task 1.
- Produces: `SourcingDeps` gains `scope?: ScanScope` (default `"full"`). `runSourcing` behavior on `"retry"`: opens the scan as `"retry"`, skips `recheckLiveness` and `expireStalePostings` (reports `expired: 0`), passes `computeRemoved: false` to `recordDirectory`.

- [ ] **Step 1: Add `scope` to `SourcingDeps` and import `ScanScope`**

In `src/cli/commands.ts`, add `ScanScope` to the `@app/discovery/scan-store` import (it currently imports `ScanStore`):
```ts
import type { ScanScope, ScanStore } from "@app/discovery/scan-store";
```
Add the field to `SourcingDeps` (after `feed`):
```ts
  /** `"retry"` scopes the run to the crawled subset: no removed-diff, no liveness re-check, no
   * expiry, and the scan is recorded as a retry so it's excluded from the staleness clock.
   * Defaults to `"full"` (the normal whole-directory scan and the hosted worker). */
  scope?: ScanScope;
```

- [ ] **Step 2: Write the failing test — a retry-scope sourcing run skips recheck + expiry**

In `src/cli/commands.test.ts`, add a test using the file's existing fake `ScanStore` (or a hand-rolled spy store — match how other `runSourcing` tests inject a store). Assert the retry path does NOT call `listLivePostingsNotSeen` / `expireStalePostings` and reports `expired: 0`:
```ts
it("skips liveness re-check and expiry on a retry-scope sourcing run", async () => {
  const calls: string[] = [];
  const store = makeFakeScanStore({
    onListLivePostingsNotSeen: () => calls.push("recheck"),
    onExpireStalePostings: () => calls.push("expire"),
  });
  const outcome = await runSourcing({
    repo: store,
    discoverDeps: fakeDiscoverDeps({ postings: [], companies: [] }),
    scope: "retry",
  });
  expect(calls).not.toContain("recheck");
  expect(calls).not.toContain("expire");
  expect(outcome.expired).toBe(0);
  expect(outcome.removedCompanies).toEqual([]);
});
```
Adapt `makeFakeScanStore` / `fakeDiscoverDeps` to the file's actual test doubles. If the file's fake store is a class, add spy counters to it; if it uses a lightweight object literal implementing `ScanStore`, thread the spies in. The key assertions: no recheck, no expire, `expired === 0`, `removedCompanies === []`.

- [ ] **Step 3: Run the test — verify it fails**

Run: `npx vitest run src/cli/commands.test.ts -t "skips liveness re-check and expiry on a retry-scope"`
Expected: FAIL — `runSourcing` currently always calls `recheckLiveness` and `expireStalePostings`, so `calls` contains both and `expired` is non-zero (or the fake records the calls).

- [ ] **Step 4: Implement scope handling in `runSourcing`**

In `src/cli/commands.ts`, update `runSourcing`. Replace the opening + directory + liveness/expiry region:
```ts
export async function runSourcing(deps: SourcingDeps): Promise<SourcingOutcome> {
  const { repo, feed, onProgress } = deps;
  // `await` every store call: a no-op for the synchronous SQLite Repository, but required for an
  // async Postgres-backed store (both satisfy the ScanStore seam).
  const scanId = await repo.startScan();
```
with:
```ts
export async function runSourcing(deps: SourcingDeps): Promise<SourcingOutcome> {
  const { repo, feed, onProgress } = deps;
  const scope = deps.scope ?? "full";
  // `await` every store call: a no-op for the synchronous SQLite Repository, but required for an
  // async Postgres-backed store (both satisfy the ScanStore seam).
  const scanId = await repo.startScan(scope);
```
Change the `recordDirectory` call:
```ts
  const diff = await repo.recordDirectory(
    scanId,
    companies.map((c) => ({ careersUrl: c.careersUrl, name: c.company })),
  );
```
to:
```ts
  // A scoped retry only crawls a subset, so the whole-directory removed-diff would flag every
  // uncrawled healthy company as "gone". Skip it; still upsert the crawled companies.
  const diff = await repo.recordDirectory(
    scanId,
    companies.map((c) => ({ careersUrl: c.careersUrl, name: c.company })),
    { computeRemoved: scope === "full" },
  );
```
Change the liveness + expiry region:
```ts
  const recheckedExpired = await recheckLiveness(
    repo,
    scanId,
    deps.discoverDeps.fetcher,
    onProgress,
  );

  const expired = recheckedExpired + (await repo.expireStalePostings(scanId));
```
to:
```ts
  // A scoped retry refreshes only the companies it crawled; it must not re-check or expire the
  // postings of companies it never looked at (that treats "not seen this scan" as "gone").
  const expired =
    scope === "full"
      ? (await recheckLiveness(repo, scanId, deps.discoverDeps.fetcher, onProgress)) +
        (await repo.expireStalePostings(scanId))
      : 0;
```

- [ ] **Step 5: Run the test — verify it passes, plus the full commands suite**

Run: `npx vitest run src/cli/commands.test.ts`
Expected: PASS (new test green; existing full-scan `runSourcing` tests still green — default scope is `"full"`).

- [ ] **Step 6: Typecheck + lint + commit**

Run: `npm run typecheck` then `./node_modules/.bin/biome check .` (both clean).
```bash
git add src/cli/commands.ts src/cli/commands.test.ts
git commit -m "feat(cli): scope runSourcing so retry scans skip directory bookkeeping"
```

---

### Task 5: `runScan` passes scope + suppresses skip-list on retry

Thread `scope` from `runScan` into `runSourcing`, and build the in-run `skipRetryFor` list ONLY on a full scan — so a `--retry-failed` run actually retries its own companies (fixes finding #4). Also surface `scope` on `ScanDeps`.

**Files:**
- Modify: `src/cli/commands.ts` (`ScanDeps` type; `runScan` body)
- Test: `src/cli/commands.test.ts`

**Interfaces:**
- Consumes: `SourcingDeps.scope` from Task 4.
- Produces: `ScanDeps` gains `scope?: ScanScope` (default `"full"`). `runScan` on `"retry"`: passes an empty `skipRetryFor` to discovery and `scope: "retry"` to `runSourcing`.

- [ ] **Step 1: Add `scope` to `ScanDeps`**

In `src/cli/commands.ts`, add to `ScanDeps` (after `onProgress`):
```ts
  /** `"retry"` runs a scoped rescan (only the given tracked companies): no directory bookkeeping,
   * and the in-run retry pass is NOT skip-listed (those companies are exactly what we want to
   * retry). Defaults to `"full"`. */
  scope?: ScanScope;
```

- [ ] **Step 2: Write the failing test — a retry-scope runScan does not skip-list its companies**

In `src/cli/commands.test.ts`, add. Seed the repo so `listRetrySkipUrls()` would return a needs-attention URL, then run `runScan` with `scope: "retry"` and assert the `discoverDeps.skipRetryFor` handed to discovery is empty (spy on the injected discover, or assert via a fake `discover` that captures its deps). Use the file's existing `runScan` test harness:
```ts
it("does not skip-list companies on a retry-scope scan", async () => {
  // Seed a needs-attention company so a full scan WOULD skip it in the retry pass.
  seedNeedsAttention(repo, "https://flaky.example/careers"); // 5x recordScanFailures, per file precedent
  const captured = captureDiscoverDeps(); // fake discover that records the deps it received
  await runScan(
    {
      repo,
      profile,
      scorer,
      discoverDeps: captured.deps,
      scope: "retry",
    },
    () => {},
  );
  expect([...(captured.received?.skipRetryFor ?? [])]).toEqual([]);
});
```
Adapt to the file's actual doubles. If `runScan` tests inject discovery via `discoverDeps` and a fake connector rather than a fake `discover`, instead assert the observable outcome: the needs-attention company gets a retry attempt (two fetch attempts). Either way, the assertion must prove the skip-list is empty on retry scope. Also confirm a `"full"` scan (or default) still passes the non-empty skip-list — add or keep a sibling assertion.

- [ ] **Step 3: Run the test — verify it fails**

Run: `npx vitest run src/cli/commands.test.ts -t "does not skip-list companies on a retry-scope"`
Expected: FAIL — `runScan` currently always computes `skipRetryFor = new Set(repo.listRetrySkipUrls())`, so the seeded URL is in the set.

- [ ] **Step 4: Implement scope-aware skip-list + scope pass-through in `runScan`**

In `src/cli/commands.ts`, replace:
```ts
export async function runScan(deps: ScanDeps, log: Logger): Promise<ScanOutcome> {
  const { onProgress, repo } = deps;

  const skipRetryFor = new Set(repo.listRetrySkipUrls());
  const sourced = await runSourcing({
    repo,
    discoverDeps: { ...deps.discoverDeps, skipRetryFor },
    ...(deps.feed ? { feed: deps.feed } : {}),
    onProgress,
  });
```
with:
```ts
export async function runScan(deps: ScanDeps, log: Logger): Promise<ScanOutcome> {
  const { onProgress, repo } = deps;
  const scope = deps.scope ?? "full";

  // Full scans skip re-hammering known-bad companies in discovery's in-run retry pass. A scoped
  // `--retry-failed` run is the opposite: those companies are exactly what we want to retry, so
  // the skip-list is empty there.
  const skipRetryFor = scope === "full" ? new Set(repo.listRetrySkipUrls()) : new Set<string>();
  const sourced = await runSourcing({
    repo,
    discoverDeps: { ...deps.discoverDeps, skipRetryFor },
    ...(deps.feed ? { feed: deps.feed } : {}),
    scope,
    onProgress,
  });
```

- [ ] **Step 5: Run the test — verify it passes, plus the full commands suite**

Run: `npx vitest run src/cli/commands.test.ts`
Expected: PASS (new test green; existing full-scan tests still green).

- [ ] **Step 6: Typecheck + lint + commit**

Run: `npm run typecheck` then `./node_modules/.bin/biome check .` (both clean).
```bash
git add src/cli/commands.ts src/cli/commands.test.ts
git commit -m "feat(cli): pass retry scope from runScan and stop skip-listing retried companies"
```

---

### Task 6: CLI + server pass `scope: "retry"`

Wire the two scoped entry points — the CLI `--retry-failed` command and the dashboard retry runner — to pass `scope: "retry"` into `runScan`. Without this the scope defaults to `"full"` and Tasks 4–5 have no effect for real users.

**Files:**
- Modify: `src/cli/main.ts` (`runScanCommand` — the `retryFailed` branch)
- Modify: `src/server/scan-runner.ts` (`createRetryFailedScanRunner`)
- Test: `src/cli/main.test.ts` (assert the retry command passes retry scope) and/or `src/server/app.test.ts`

**Interfaces:**
- Consumes: `ScanDeps.scope` from Task 5.
- Produces: no new exports — both scoped call sites now set `scope: "retry"`.

- [ ] **Step 1: Write the failing test — the CLI retry path runs a retry-scope scan**

In `src/cli/main.test.ts`, extend the existing `--retry-failed` coverage. The cleanest observable assertion without real network: seed a needs-attention company, run `runScanCommand(repo, log, true)` with an injected fake discovery, and assert the scan recorded was a `"retry"` scan (query `scans.kind` for the latest row) AND no healthy uncrawled posting was expired. If `runScanCommand` constructs its own `PlaywrightRenderer`/`HttpFetcher` (hard to fake here), prefer asserting at the `runScan` seam in `commands.test.ts` instead and keep this step a thin check that `runScanCommand` reaches `runScan` with `retryFailed` → scope `"retry"`. Concretely, assert the latest scan's kind:
```ts
it("runs --retry-failed as a retry-scope scan", async () => {
  seedNeedsAttention(repo, "https://flaky.example/careers");
  // Inject a fake so no real browser/network is used; match how other main.test.ts scan tests do it.
  await runScanCommandForTest(repo, { retryFailed: true, discover: fakeDiscover({ postings: [] }) });
  const kind = (
    repo["db"].prepare("SELECT kind FROM scans ORDER BY id DESC LIMIT 1").get() as { kind: string }
  ).kind;
  expect(kind).toBe("retry");
});
```
If `runScanCommand`'s current signature can't inject discovery, this test belongs at the `runScan` level (Task 5 already covers the empty-skip-list); in that case, assert here only that a `--retry-failed` invocation with an empty needs-attention list short-circuits (existing behavior) and add the `scope` assertion where discovery is injectable. Do not fake the network with a real `PlaywrightRenderer`.

- [ ] **Step 2: Run the test — verify it fails**

Run: `npx vitest run src/cli/main.test.ts -t "runs --retry-failed as a retry-scope scan"`
Expected: FAIL — the latest scan's kind is `"full"` because `runScanCommand` doesn't pass `scope`.

- [ ] **Step 3: Pass `scope: "retry"` in the CLI command**

In `src/cli/main.ts`, import the `ScanScope` type (add to the existing `@app/discovery/scan-store` import if present, else a new `import type` line):
```ts
import type { ScanScope } from "@app/discovery/scan-store";
```
In `runScanCommand`, above the `runScan(` call, declare a typed scope variable (a type annotation on a variable — no `as` cast, satisfying the no-assertion rule):
```ts
  const scanScope: ScanScope | undefined = retryFailed ? "retry" : undefined;
```
Then in the `runScan` deps object, add a conditional spread alongside the existing `...(feed ? { feed } : {})`:
```ts
      ...(scanScope ? { scope: scanScope } : {}),
```

- [ ] **Step 4: Pass `scope: "retry"` in the dashboard retry runner**

In `src/server/scan-runner.ts`, in `createRetryFailedScanRunner`, add `scope: "retry"` to the `runScan` deps object (alongside `...(feed ? { feed } : {})`). Type it to avoid a cast — either the deps object accepts the literal directly (since `ScanDeps.scope?: ScanScope`, a literal `"retry"` is assignable), so simply add:
```ts
        scope: "retry",
```
A bare string literal `"retry"` assigned to a `scope?: ScanScope` field is inferred as the union member with no assertion needed. Confirm via typecheck.

- [ ] **Step 5: Run the test — verify it passes, plus the CLI + server suites**

Run: `npx vitest run src/cli/main.test.ts src/server/app.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + lint + commit**

Run: `npm run typecheck` then `./node_modules/.bin/biome check .` (both clean).
```bash
git add src/cli/main.ts src/server/scan-runner.ts src/cli/main.test.ts
git commit -m "feat: run --retry-failed and dashboard rescan as retry-scope scans"
```

---

### Task 7: In-run retry pass respects concurrency + politeness

Route `discover()`'s in-run retry pass through the same `pLimit(concurrency)` + `waitTurn()` scheduler the main pass uses, so a burst of failed companies doesn't fire unbounded simultaneous re-fetches. Benefits full and scoped scans alike.

**Files:**
- Modify: `src/discovery/discover.ts` (the retry pass — currently a raw `Promise.all` over `toRetry`)
- Test: `src/discovery/discover.test.ts`

**Interfaces:**
- Consumes: the existing `limit` (`pLimit(concurrency)`) and `waitTurn` closures already defined in `discover()`.
- Produces: no signature change — the retry pass now schedules through `limit` + `waitTurn`.

- [ ] **Step 1: Write the failing test — the retry pass bounds concurrency**

In `src/discovery/discover.test.ts`, add a test that forces the main pass to fail all leads (so they all go to the retry pass), injects a `fetcher`/connector that tracks concurrent in-flight calls during the RETRY pass, and asserts the peak concurrency never exceeds the configured cap. Match the file's existing concurrency-observing pattern (the main-pass tests already do this — reuse their in-flight counter). Sketch:
```ts
it("bounds concurrency in the retry pass", async () => {
  let inFlight = 0;
  let peak = 0;
  const connector = trackingConnector(async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await tick();
    inFlight--;
    // First call per lead fails (main pass), forcing the retry pass to run.
    // Use a per-lead attempt counter so the retry attempt observes concurrency.
  });
  await discover({
    ...fakeDiscoverDeps({ leads: manyLeads(10), connector }),
    concurrency: 2,
    delayMs: 0,
  });
  expect(peak).toBeLessThanOrEqual(2);
});
```
Adapt to the file's actual fakes (`fakeDiscoverDeps`, how leads/connectors are injected, how a lead is made to fail once then be observed on retry). The essential assertion: with `concurrency: 2` and ≥3 retried leads, peak in-flight during the retry pass is ≤ 2. Under the current raw `Promise.all`, peak equals the number of retried leads.

- [ ] **Step 2: Run the test — verify it fails**

Run: `npx vitest run src/discovery/discover.test.ts -t "bounds concurrency in the retry pass"`
Expected: FAIL — peak in-flight equals the retried-lead count (e.g. 10), exceeding the cap of 2, because the retry pass uses an unbounded `Promise.all`.

- [ ] **Step 3: Route the retry pass through `waitTurn` + `limit`**

In `src/discovery/discover.ts`, the retry pass currently reads:
```ts
      const retried = await Promise.all(
        toRetry.map(async ({ lead }): Promise<{ lead: CompanyLead; result: ConnectorResult }> => {
          try {
            return { lead, result: await fetchLead(lead) };
          } catch (error) {
            return { lead, result: { ok: false, warning: errorMessage(error) } };
          }
        }),
      );
```
Replace it with the bounded, spaced form (mirroring the main pass at lines ~151-171):
```ts
      const retried = await Promise.all(
        toRetry.map(async ({ lead }) => {
          await waitTurn();
          return limit(async (): Promise<{ lead: CompanyLead; result: ConnectorResult }> => {
            try {
              return { lead, result: await fetchLead(lead) };
            } catch (error) {
              return { lead, result: { ok: false, warning: errorMessage(error) } };
            }
          });
        }),
      );
```
`waitTurn` and `limit` are the same closures the main pass uses (defined earlier in `discover()`), so the retry pass now shares the concurrency cap and inter-request delay.

- [ ] **Step 4: Run the test — verify it passes, plus the full discover suite**

Run: `npx vitest run src/discovery/discover.test.ts`
Expected: PASS (new test green; existing retry-pass tests — which assert the second attempt happens and warnings carry `careersUrl` — still green, since scheduling changed but not outcomes).

- [ ] **Step 5: Typecheck + lint + commit**

Run: `npm run typecheck` then `./node_modules/.bin/biome check .` (both clean).
```bash
git add src/discovery/discover.ts src/discovery/discover.test.ts
git commit -m "fix(discovery): bound the in-run retry pass to the main-pass concurrency + politeness"
```

---

### Task 8: Dashboard invalidates needs-attention after a Rescan

Invalidate the `["companies","needs-attention"]` query when a scan finishes, so a recovered company drops off the panel without a page reload. Mirror `Home.tsx`'s `finishedAt`-keyed effect.

**Files:**
- Modify: `web/src/views/Companies.tsx` (add a scan-completion effect)
- Test: `web/src/views/Companies.test.tsx`

**Interfaces:**
- Consumes: `useScanStatus()` (`web/src/hooks.ts:150`, query key `["scan-status"]`, exposes `state`/`finishedAt`) and `useQueryClient` from `@tanstack/react-query`.
- Produces: no new exports — a `useEffect` in `Companies()` that invalidates `["companies","needs-attention"]` on scan completion.

- [ ] **Step 1: Write the failing test — the panel refreshes after a scan completes**

In `web/src/views/Companies.test.tsx`, add a test that: renders Companies with a mocked `fetch` where `/api/companies/needs-attention` first returns one company; the scan status starts `running` then flips to `done`; assert the component re-fetches `/api/companies/needs-attention` after completion (e.g. the second response returns `[]` and the panel disappears). Follow the file's existing URL-routed `mockFetch` pattern and its `QueryClient` wrapper. Sketch:
```ts
it("refreshes the needs-attention panel after a scan completes", async () => {
  const needsAttention = [{ careersUrl: "https://a/x", company: "A", message: "m", consecutiveFailures: 5 }];
  let scanState = "running";
  let naBody = needsAttention;
  mockFetch((url) => {
    if (url.includes("/api/companies/needs-attention")) return json(naBody);
    if (url.includes("/api/scan/status")) return json({ state: scanState, finishedAt: scanState === "done" ? "t1" : null });
    // ...other endpoints return their defaults
  });
  render(<Wrapped />);
  expect(await screen.findByText(/Needs attention/i)).toBeInTheDocument();
  // Scan completes; the recovered company is gone on the next fetch.
  naBody = [];
  scanState = "done";
  // advance the scan-status poll / trigger a refetch as the file's other tests do
  await waitFor(() => expect(screen.queryByText(/Needs attention/i)).not.toBeInTheDocument());
});
```
Adapt endpoint URLs and the poll-advance mechanism to the file's helpers. The essential assertion: on scan completion, the needs-attention query refetches (panel reflects the new empty list).

- [ ] **Step 2: Run the test — verify it fails**

Run: `npm run test:web -- src/views/Companies.test.tsx -t "refreshes the needs-attention panel"`
Expected: FAIL — without the invalidation effect the panel keeps the stale (non-empty) list; the assertion that it disappears times out.

- [ ] **Step 3: Add the scan-completion invalidation effect to Companies**

In `web/src/views/Companies.tsx`, add imports:
```ts
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useScanStatus } from "../hooks";
```
(`useEffect` may need to join the existing `react` import; `useScanStatus` joins the existing `../hooks` import.)

Inside `Companies()`, after the existing hook calls, add:
```ts
  const qc = useQueryClient();
  const scanStatus = useScanStatus();
  // A retry-failed scan (the Rescan button) runs in the background; when it finishes, a company may
  // have recovered and been cleared from failed_leads. Refresh the needs-attention list so the
  // panel reflects that without a page reload. Keyed on finishedAt so each completed scan re-runs.
  const finishedAt = scanStatus.data?.state === "done" ? scanStatus.data.finishedAt : null;
  useEffect(() => {
    if (finishedAt) qc.invalidateQueries({ queryKey: ["companies", "needs-attention"] });
  }, [finishedAt, qc]);
```
Confirm the `ScanJobStatus` type exposes `finishedAt` on the `done` state (it does — Home.tsx reads `status.finishedAt` the same way); if the discriminated union names differ, match Home.tsx's access exactly.

- [ ] **Step 4: Run the test — verify it passes, plus the full web suite**

Run: `npm run test:web`
Expected: PASS (new test green; all existing web tests green).

- [ ] **Step 5: Typecheck + lint + commit**

Run: `npm run typecheck:web` then `./node_modules/.bin/biome check .` (both clean).
```bash
git add web/src/views/Companies.tsx web/src/views/Companies.test.tsx
git commit -m "fix(web): refresh the needs-attention panel when a rescan completes"
```

---

### Task 9: Full-suite verification + Postgres-worker seam audit

No new code — the gate. Confirm the whole CI-equivalent suite is green and that the shared `ScanStore` seam changes did not alter the hosted Postgres worker's behavior.

**Files:** none (verification only).

- [ ] **Step 1: Run the full CI-equivalent suite**

Run each and confirm clean:
```bash
./node_modules/.bin/biome check .
npm run typecheck
npm run typecheck:web
npm run test:coverage
npm run test:web
npm run build:web
```
Expected: lint clean (only the pre-existing `biome.json` deprecation info); both typechecks clean; `test:coverage` passes with the gate green (statements ≥93 / branches ≥85 / functions ≥90 / lines ≥93); `test:web` green; `build:web` clean.

- [ ] **Step 2: Audit the Postgres-worker seam**

Confirm the `ScanStore` interface changes are additive/optional and the worker is untouched:
```bash
git diff --name-only $(git merge-base main HEAD)...HEAD -- src/backend/ src/discovery/scan-store.ts
```
Expected: `src/discovery/scan-store.ts` appears (interface widened), but NO file under `src/backend/` is listed. Then confirm `run-once.ts` still calls `startScan()` / `recordDirectory(scanId, companies)` with the old arity (new params optional, default full):
```bash
git grep -n "startScan\|recordDirectory" -- src/backend/scanner/run-once.ts
```
Expected: the worker calls remain valid under the widened signatures (typecheck in Step 1 already proves this). Note the result in the ledger.

- [ ] **Step 3: Commit (if any incidental lint/format fixes were needed)**

If Steps 1-2 required no changes, skip. Otherwise:
```bash
git add -A
git commit -m "chore: verification fixups for scoped-scan mode"
```

---

### Task 10: Whole-branch review + rebase + PR

Final gate: rebase onto latest `main` (which advanced to `109a796` — PR #86 merged), re-verify, run the whole-branch review, triage any findings, and open the PR.

**Files:** none (review + integration).

- [ ] **Step 1: Rebase onto latest main**

Fetch and rebase (a safety backup branch already exists from the prior round; create a fresh one for this rebase):
```bash
git fetch origin main
git branch -f backup/scoped-scan-pre-rebase HEAD
git rebase origin/main
```
Resolve any conflicts (main #86 touched `web/src/views/Matches.tsx` / match cards — unlikely to collide with this branch's storage/CLI/Companies changes). After a clean rebase, re-run the full suite from Task 9 Step 1 — a clean rebase can still produce semantic breakage when two changesets touch adjacent lines.

- [ ] **Step 2: Whole-branch review**

Run the whole-branch review on the most capable model over the full branch diff (`git merge-base main HEAD`..HEAD), pointing it at the scoped-scan spec and this plan, and at the deferred-findings list (#7–#10 from the code-review) for triage. Dispatch ONE fix subagent with the complete findings list if any Critical/Important survive; re-verify.

- [ ] **Step 3: Staff-eng pre-flight**

Run the staff-eng pre-flight lens over the rebased diff; record the sentinel only on a READY verdict.

- [ ] **Step 4: Open the PR**

After explicit user go-ahead (externally-visible mutation): push the branch and `gh pr create` against `main`. PR body: summarize the smart-follow-up-scanning feature AND the scoped-scan-mode correctness fix (the two design docs), the full-suite evidence, and the deferred follow-ups (#7 companyId feed-scoping, #8 empty-list UX, #9/#10 polish). No Claude co-authored footer.

---

## Notes for the implementer

- **`git grep` over shell `grep`:** in this environment plain `grep` on working-tree files has returned empty spuriously; use `git grep` or the Read tool to locate code.
- **Watch for unexpected `main` checkouts:** this branch's working tree has twice been found checked out to `main` mid-session. If files look wrong, run `git branch --show-current`; recover with `git checkout feat/retry-failed-companies`. No commits are lost — they live on the branch.
- **Adapt test doubles to each file's existing fakes.** The sketches above name helpers (`makeRepo`, `fakeDiscoverDeps`, `mockFetch`, `seedNeedsAttention`) generically; use whatever each test file actually provides, matching its neighbors. The assertions (what must be true) are fixed; the plumbing follows the file.
- **`seedNeedsAttention` precedent:** to put a company on the needs-attention list, call `recordScanFailures` five times for it (threshold is 5) — `src/storage/repository.test.ts` and `src/cli/main.test.ts` already do this. Pass the third `attemptedUrls` argument each time (that URL).

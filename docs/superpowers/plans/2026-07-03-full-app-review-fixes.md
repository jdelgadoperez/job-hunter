# Full-App Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 15 Tier-1 + Tier-2 findings from the 8-agent full-app review of job-hunter @ 8702548.

**Architecture:** Fixes span five subsystems — the deep-score web UI, the Postgres/SQLite `ScanStore` parity seam, the scan pipeline's degradation invariant, the SQLite schema, the SSRF fetcher's test coverage, React render/polling behavior, web accessibility, the CLI error/help surface, and two UX affordances. Each fix is independently testable and reviewable.

**Tech Stack:** TypeScript (strict, ESM), better-sqlite3, porsager `postgres`, Hono, React 19 + TanStack Query + Tailwind v4, vitest (server) + jsdom/RTL (web), Biome.

## Global Constraints

- **TypeScript strict, ESM.** `noUncheckedIndexedAccess` + `noImplicitOverride` on. Import server/CLI via `@app/*`.
- **NEVER use the `!` non-null assertion.** Avoid type assertions except in tests / established file idioms.
- **No new dependencies** — use existing deps or small custom helpers.
- **Biome** for lint+format: 2-space indent, 100-col, double quotes. Run `./node_modules/.bin/biome check .` (NOT `npm run lint`) before declaring a task done.
- **Coverage gate:** statements 93 / branches 85 / functions 90 / lines 93. New code keeps these green.
- **Failures degrade, never crash.** Discovery and scoring collect `Warning`s and return partial results — a single company or a failed LLM call must not abort a scan.
- **Conventional Commits.** Do NOT add a Claude co-authored footer.
- **Prefer JS `Date`/date-fns over Moment** (n/a here; SQLite/PG time functions used).
- **CI gate order:** lint → typecheck → typecheck:web → test:coverage → test:web → build:web. A task touching web code must pass `npm run typecheck:web` and `npm run test:web`; a task touching server/CLI must pass `npm run typecheck` and the relevant `npx vitest run <file>`.
- **Postgres SQL execution is smoke-tested only** (`smoke:postgres`), NOT unit-tested. Pure row mapping is unit-tested in `postgres-mappers.test.ts`. Do NOT try to unit-test live Postgres queries; verify query *shape* by reading, and add mapper/guard unit tests where the logic is pure.

---

## File Structure

- `web/src/views/Home.tsx` — deep-score gate (T1), aria-atomic (T13a)
- `web/src/views/Matches.tsx` — memoize MatchCard (T8), expired non-color signal (T12)
- `web/src/views/Companies.tsx` — remove-confirm (T15)
- `web/src/hooks.ts` — shared/visibility-gated status polling (T9)
- `web/src/App.tsx` — pass active-tab signal to gate polling (T9)
- `src/backend/schema.sql` — `scans.kind` column + index (T2)
- `src/backend/postgres-scan-store.ts` — scope-threaded startScan, computeRemoved, kind='full' staleness (T2, T3)
- `src/storage/schema.ts` — `companies.last_seen_at` index (T6)
- `src/cli/commands.ts` — guard the scoring loop (T5)
- `src/net/fetcher.ts` — inject `fetch` for testability (T4)
- `src/net/fetcher.test.ts` — SSRF redirect-loop tests (T4)
- `src/cli/parse.ts` — convert parseArgs throws to help/error (T10)
- `src/cli/help.ts` — document `list` filter flags (T11)
- `src/cli/commands.test.ts` — DB-outcome assertion on incremental invariant (T7)

---

### Task 1: Deep-score spend gate (Finding #1, HIGH)

Enforce the preview-before-spend gate the code comment already claims, and invalidate a stale estimate when the run's options change.

**Files:**
- Modify: `web/src/views/Home.tsx` (the `DeepScoreCard` component, ~lines 225-352)
- Test: `web/src/views/Home.test.tsx`

**Interfaces:**
- Consumes: `useScorePreview()` (returns `{ data, mutate, reset, isPending, isError, error }`), `useStartDeepScore()`, `ScorePreview` type. All existing.
- Produces: nothing consumed downstream — purely local component behavior.

- [ ] **Step 1: Write failing tests** in `web/src/views/Home.test.tsx`. Follow the existing test setup in that file (it already mocks the API and renders `Home`). Add a `describe("DeepScoreCard spend gate")` with:

```tsx
// Assumes the file's existing render helper + fetch mock. Mirror how other Home tests
// arrange `hasKey: true` (settings API returns an anthropicApiKey present) and no running scan.
test("Deep-score button is disabled until a preview has been run", async () => {
  renderHome({ hasKey: true }); // use the file's existing helper; adapt name if different
  const deepScore = await screen.findByRole("button", { name: /deep-score/i });
  expect(deepScore).toBeDisabled();

  await userEvent.click(screen.getByRole("button", { name: /preview/i }));
  // preview resolves → estimate shows → button enables
  await screen.findByText(/est\./i);
  expect(screen.getByRole("button", { name: /deep-score/i })).toBeEnabled();
});

test("changing an option after preview re-disables Deep-score and clears the estimate", async () => {
  renderHome({ hasKey: true });
  await userEvent.click(screen.getByRole("button", { name: /preview/i }));
  await screen.findByText(/est\./i);

  await userEvent.click(screen.getByRole("checkbox", { name: /remote only/i }));

  expect(screen.queryByText(/est\./i)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /deep-score/i })).toBeDisabled();
});
```

If the existing test file has no render helper for `Home`, write a minimal one in-file that mounts `<Home />` inside a `QueryClientProvider` with the file's existing fetch mock. Do NOT hard-code expected estimate dollar values — assert on the presence/absence of the `est.` text, not its amount.

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:web -- Home`
Expected: FAIL — Deep-score button is currently enabled without a preview; estimate not cleared on option change.

- [ ] **Step 3: Implement the gate.** In `DeepScoreCard` (`Home.tsx`):
  1. Add `!previewData` to the Deep-score button's `disabled` condition (currently `blocked || startDeepScore.isPending` at ~line 329):
     ```tsx
     <Button onClick={runDeepScore} disabled={blocked || startDeepScore.isPending || !previewData}>
     ```
  2. Invalidate the preview when any run option changes. The three `setX` handlers (remoteOnly ~297, rescore ~307, limit ~318) each also call `preview.reset()`. Extract a small helper so it's DRY:
     ```tsx
     function changeOption<T>(setter: (v: T) => void, value: T) {
       setter(value);
       preview.reset(); // a prior estimate no longer describes the pending run
     }
     ```
     Wire each control: `onChange={(e) => changeOption(setRemoteOnly, e.target.checked)}`, etc. (For `limit`, keep the existing `Math.max(1, Number(...) || 1)` clamp inside the value passed to `changeOption`.)
  3. Keep the existing `runDeepScore` `onSuccess: () => preview.reset()`.
  4. Update the docstring at ~line 220-223 only if wording drifts; the "gated behind the preview" claim is now TRUE.

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:web -- Home`
Expected: PASS (both new tests + all pre-existing Home tests).

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck:web` then `./node_modules/.bin/biome check web/src/views/Home.tsx`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/views/Home.tsx web/src/views/Home.test.tsx
git commit -m "fix(web): gate deep-score run behind a fresh preview estimate"
```

---

### Task 2: Postgres `scans.kind` column + parity (Finding #2 part A, HIGH)

Add the `kind` column to the Postgres schema and thread scope through `startScan`, so a non-full scope is recorded and available to the staleness clock.

**Files:**
- Modify: `src/backend/schema.sql`
- Modify: `src/backend/postgres-scan-store.ts` (`startScan`)
- Test: `src/backend/postgres-scan-store.test.ts` (create if absent — see note)

**Interfaces:**
- Consumes: `ScanScope` from `@app/discovery/scan-store` (`"full" | "retry" | "incremental"`).
- Produces: `startScan(kind?: ScanScope)` matching the `ScanStore` interface signature exactly.

**Note on testing:** live Postgres is smoke-only. There is likely no `postgres-scan-store.test.ts`. Do NOT stand up a real PG connection. Instead, unit-test `startScan` by passing a **fake `Sql`** — a tagged-template function that records the interpolated values. Porsager's `sql` is called as `` sql`INSERT ... ${x}` ``, i.e. a function taking `(strings: TemplateStringsArray, ...values)`. A fake can capture `values` and return a resolved array. If constructing a faithful fake is too fragile, instead assert the SQL *shape* is correct by reading and add a `postgres-mappers`-style pure test only where logic is pure; document in the report that live execution is covered by `smoke:postgres`. Prefer the fake-`Sql` approach if achievable.

- [ ] **Step 1: Add the column to `schema.sql`.** In the `scans` table (lines 19-27) the column can't use `create table` alone (idempotency for existing DBs), so add BOTH: include `kind` in the `create table if not exists` AND an idempotent `alter table ... add column if not exists` in the migration block (near lines 65-79). Match the SQLite default (`'full'`):

```sql
-- in create table scans (...):
  kind text not null default 'full',

-- in the idempotent migration block:
alter table scans add column if not exists kind text not null default 'full';
-- Staleness clock (expireStalePostings) counts only full scans; index the predicate.
create index if not exists scans_kind_idx on scans (kind, id);
```

- [ ] **Step 2: Write a failing test** for `startScan` threading `kind`. In `src/backend/postgres-scan-store.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { PostgresScanStore } from "./postgres-scan-store";

// Minimal fake of porsager's tagged-template `sql`. Captures the values array of each call.
function fakeSql(returnRows: unknown[]) {
  const calls: { strings: readonly string[]; values: unknown[] }[] = [];
  const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: [...strings], values });
    return Promise.resolve(returnRows);
  };
  return Object.assign(fn, { calls });
}

describe("PostgresScanStore.startScan", () => {
  test("threads the scan kind into the insert", async () => {
    const sql = fakeSql([{ id: "42" }]);
    // biome-ignore lint: fake Sql for unit test
    const store = new PostgresScanStore(sql as never);
    const id = await store.startScan("incremental");
    expect(id).toBe(42);
    const insert = sql.calls.find((c) => c.strings.join("").includes("INSERT INTO scans"));
    expect(insert?.values).toContain("incremental");
  });

  test("defaults to full when no kind is passed", async () => {
    const sql = fakeSql([{ id: "1" }]);
    // biome-ignore lint: fake Sql for unit test
    const store = new PostgresScanStore(sql as never);
    await store.startScan();
    const insert = sql.calls.find((c) => c.strings.join("").includes("INSERT INTO scans"));
    expect(insert?.values).toContain("full");
  });
});
```

- [ ] **Step 2b: Run to verify failure**

Run: `npx vitest run src/backend/postgres-scan-store.test.ts`
Expected: FAIL — current `startScan()` takes no arg and inserts no `kind`.

- [ ] **Step 3: Implement.** In `postgres-scan-store.ts`, change `startScan` (lines 36-40):

```ts
async startScan(kind: ScanScope = "full"): Promise<number> {
  const rows = await this.sql<{ id: string }[]>`
    INSERT INTO scans (started_at, kind) VALUES (now(), ${kind}) RETURNING id`;
  return Number(rows[0]?.id);
}
```

Add `import type { ScanScope } from "@app/discovery/scan-store";` (extend the existing type import on line 2 to `import type { DirectoryDiff, ScanScope, ScanStore } from "@app/discovery/scan-store";`).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/backend/postgres-scan-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck` then `./node_modules/.bin/biome check src/backend/`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/backend/schema.sql src/backend/postgres-scan-store.ts src/backend/postgres-scan-store.test.ts
git commit -m "feat(backend): record scan kind in Postgres scans table"
```

---

### Task 3: Postgres `recordDirectory` computeRemoved + `kind='full'` staleness (Finding #2 part B + #4, HIGH/Important)

Bring `PostgresScanStore.recordDirectory` and `expireStalePostings` to full parity with SQLite: honor `computeRemoved`, and count only `kind='full'` scans toward the staleness clock.

**Files:**
- Modify: `src/backend/postgres-scan-store.ts` (`recordDirectory`, `expireStalePostings`)
- Test: `src/backend/postgres-scan-store.test.ts` (extend)

**Interfaces:**
- Consumes: the `kind` column added in Task 2.
- Produces: `recordDirectory(scanId, companies, options?: { computeRemoved?: boolean })` and an `expireStalePostings` whose staleness matches SQLite's `WHERE kind='full'` semantics.

- [ ] **Step 1: Write failing tests** (extend `postgres-scan-store.test.ts`). Using the same `fakeSql` helper, assert:
  1. `recordDirectory(id, companies, { computeRemoved: false })` returns `{ newCompanies: [], removedCompanies: [] }` regardless of the fake's existing-rows response.
  2. `expireStalePostings`'s SQL text contains a `kind = 'full'` predicate (shape assertion, since live execution is smoke-only).

```ts
test("recordDirectory honors computeRemoved:false", async () => {
  // Fake returns pre-existing companies + a prev scan, but computeRemoved:false must suppress the diff.
  const sql = fakeSql([]); // adapt: recordDirectory issues several queries; return [] for each
  // biome-ignore lint: fake Sql
  const store = new PostgresScanStore(sql as never);
  const diff = await store.recordDirectory(5, [{ careersUrl: "https://x.co" }], {
    computeRemoved: false,
  });
  expect(diff).toEqual({ newCompanies: [], removedCompanies: [] });
});

test("expireStalePostings counts only full scans in its staleness predicate", async () => {
  const sql = fakeSql([]);
  // biome-ignore lint: fake Sql
  const store = new PostgresScanStore(sql as never);
  await store.expireStalePostings(10, 2);
  const update = sql.calls.find((c) => c.strings.join("").includes("UPDATE postings SET expired_at"));
  expect(update?.strings.join("")).toContain("kind = 'full'");
});
```

Note: `recordDirectory` issues multiple `sql` calls (SELECT existing, SELECT prev, INSERT chunks). The `fakeSql` must return a resolvable array for each; a single shared `[]` works if every consumer tolerates an empty array. If a call needs a shaped row, extend `fakeSql` to return per-call-index responses. Keep it minimal.

- [ ] **Step 1b: Run to verify failure**

Run: `npx vitest run src/backend/postgres-scan-store.test.ts`
Expected: FAIL — `recordDirectory` currently ignores options; `expireStalePostings` uses id arithmetic with no `kind` predicate.

- [ ] **Step 2: Implement `recordDirectory` options.** Change the signature (line 42) to accept options and gate the diff, mirroring SQLite (`repository.ts:558-590`):

```ts
async recordDirectory(
  scanId: number,
  companies: CompanyRef[],
  options: { computeRemoved?: boolean } = {},
): Promise<DirectoryDiff> {
  const computeRemoved = options.computeRemoved ?? true;
  // ... existing existing/prev queries ...
  const newCompanies =
    !computeRemoved || isBaseline ? [] : companies.filter((c) => !existingUrls.has(c.careersUrl));
  const removedCompanies =
    !computeRemoved || isBaseline || prevScan === null
      ? []
      : existing
          .filter((e) => Number(e.last_seen_scan) === prevScan && !currentUrls.has(e.careers_url))
          .map((e) => ({ careersUrl: e.careers_url, ...(e.name ? { name: e.name } : {}) }));
  // ... existing upsert ...
}
```

- [ ] **Step 3: Implement `kind='full'` staleness.** Change `expireStalePostings` (lines 191-198) to join `scans` and count only full scans, matching SQLite's semantics (`repository.ts:702-712`):

```ts
async expireStalePostings(scanId: number, staleAfter = 2): Promise<number> {
  const rows = await this.sql`
    UPDATE postings SET expired_at = now()
    WHERE expired_at IS NULL AND last_seen_scan IS NOT NULL
      AND (
        SELECT COUNT(*) FROM scans
        WHERE kind = 'full' AND id > postings.last_seen_scan AND id <= ${scanId}
      ) >= ${staleAfter}
    RETURNING id`;
  return rows.length;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/backend/postgres-scan-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the class docstring.** The claim at `postgres-scan-store.ts:24-26` ("same upsert/revival/expiry semantics") is now actually true for all scopes — keep it, and add a one-line note that `kind`-aware staleness matches SQLite. Verify `npm run typecheck` + `./node_modules/.bin/biome check src/backend/`.

- [ ] **Step 6: Commit**

```bash
git add src/backend/postgres-scan-store.ts src/backend/postgres-scan-store.test.ts
git commit -m "feat(backend): Postgres store honors computeRemoved and full-scan staleness clock"
```

---

### Task 4: SSRF redirect-loop tests (Finding #3, HIGH)

Make `HttpFetcher`'s manual redirect loop unit-testable by injecting `fetch`, then test the per-hop SSRF re-check, GET-only redirect, and MAX_REDIRECTS guard.

**Files:**
- Modify: `src/net/fetcher.ts` (inject `fetch` + allow injecting the guard)
- Test: `src/net/fetcher.test.ts`

**Interfaces:**
- Consumes: `assertAllowedUrl` from `./ssrf-guard`.
- Produces: `HttpFetcher` constructor gains optional injectable deps: `new HttpFetcher(timeoutMs?, deps?: { fetchImpl?: typeof fetch; assertAllowed?: (url: string) => Promise<void> })`. Default to global `fetch` and the real `assertAllowedUrl` — production behavior unchanged.

- [ ] **Step 1: Refactor `HttpFetcher` for injection** (production behavior identical). In `fetcher.ts`:

```ts
export class HttpFetcher implements Fetcher {
  private readonly fetchImpl: typeof fetch;
  private readonly assertAllowed: (url: string) => Promise<void>;
  constructor(
    private readonly timeoutMs = 15_000,
    deps: { fetchImpl?: typeof fetch; assertAllowed?: (url: string) => Promise<void> } = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.assertAllowed = deps.assertAllowed ?? assertAllowedUrl;
  }

  async fetch(url: string, init?: FetchInit): Promise<FetchResponse> {
    // ... same body, but call this.assertAllowed(current) and this.fetchImpl(current, {...}) ...
  }
}
```

Replace the two call sites inside the loop: `await this.assertAllowed(current);` and `const res = await this.fetchImpl(current, {...});`.

- [ ] **Step 2: Write failing tests** in `src/net/fetcher.test.ts`. Add a `describe("HttpFetcher redirect loop")`:

```ts
import { describe, expect, test, vi } from "vitest";
import { HttpFetcher } from "./fetcher";

function response(status: number, body: string, location?: string): Response {
  const headers = new Headers();
  if (location) headers.set("location", location);
  return { status, headers, text: async () => body } as unknown as Response;
}

test("re-checks SSRF on every redirect hop", async () => {
  const assertAllowed = vi.fn(async () => {});
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(response(302, "", "https://internal.example/next"))
    .mockResolvedValueOnce(response(200, "ok"));
  const f = new HttpFetcher(1000, { fetchImpl: fetchImpl as unknown as typeof fetch, assertAllowed });
  const res = await f.fetch("https://public.example/start");
  expect(res.statusCode).toBe(200);
  // guard ran for BOTH the initial URL and the redirect target
  expect(assertAllowed).toHaveBeenCalledTimes(2);
  expect(assertAllowed).toHaveBeenNthCalledWith(2, "https://internal.example/next");
});

test("a redirect to a blocked host is rejected by the per-hop guard", async () => {
  const assertAllowed = vi
    .fn()
    .mockResolvedValueOnce(undefined) // initial URL allowed
    .mockRejectedValueOnce(new Error("blocked: internal address")); // redirect target blocked
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(response(302, "", "http://169.254.169.254/"));
  const f = new HttpFetcher(1000, { fetchImpl: fetchImpl as unknown as typeof fetch, assertAllowed });
  await expect(f.fetch("https://public.example/start")).rejects.toThrow(/blocked/);
});

test("does not follow redirects for non-GET methods", async () => {
  const assertAllowed = vi.fn(async () => {});
  const fetchImpl = vi.fn().mockResolvedValueOnce(response(302, "", "https://elsewhere.example/"));
  const f = new HttpFetcher(1000, { fetchImpl: fetchImpl as unknown as typeof fetch, assertAllowed });
  const res = await f.fetch("https://public.example/", { method: "POST", body: "x" });
  expect(res.statusCode).toBe(302); // returned as-is, not followed
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test("throws after exceeding MAX_REDIRECTS", async () => {
  const assertAllowed = vi.fn(async () => {});
  const fetchImpl = vi.fn(async () => response(302, "", "https://public.example/loop"));
  const f = new HttpFetcher(1000, { fetchImpl: fetchImpl as unknown as typeof fetch, assertAllowed });
  await expect(f.fetch("https://public.example/loop")).rejects.toThrow(/too many redirects/);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/net/fetcher.test.ts`
Expected: FAIL before Step 1's refactor is applied; after the refactor these should be the RED-then-GREEN target. (If you did Step 1 first, run now to confirm they PASS — the refactor must not change behavior. If any fail, the refactor changed behavior; fix the refactor, not the test.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/net/fetcher.test.ts`
Expected: PASS (new + existing FakeFetcher tests).

- [ ] **Step 5: Typecheck + lint + coverage spot-check**

Run: `npm run typecheck` then `./node_modules/.bin/biome check src/net/fetcher.ts src/net/fetcher.test.ts`
Then confirm the file is no longer a coverage blind spot: `npx vitest run src/net/fetcher.test.ts --coverage` and check `fetcher.ts` statement coverage is materially up from ~18%.
Expected: clean; coverage up.

- [ ] **Step 6: Commit**

```bash
git add src/net/fetcher.ts src/net/fetcher.test.ts
git commit -m "test(net): cover HttpFetcher redirect loop + per-hop SSRF re-check"
```

---

### Task 5: Guard the scoring loop (Finding #5, Important)

Make the scoring loop degrade-never-crash like the `recordScanFailures` block below it: a scorer/`saveMatchResult` throw must not abort a scan whose sourcing already committed.

**Files:**
- Modify: `src/cli/commands.ts` (~lines 332-343)
- Test: `src/cli/commands.test.ts`

**Interfaces:**
- Consumes: `deps.scorer.score`, `repo.saveMatchResult`, existing `log` + `style.warn` + `errorMessage` (all already imported/used at lines 359-361).
- Produces: no signature change — `runScan` still returns its outcome; a per-posting scoring failure becomes a warning, not a throw.

- [ ] **Step 1: Write a failing test** in `src/cli/commands.test.ts`. Find how existing `runScan` tests inject deps (a fake scorer + in-memory `Repository`). Add:

```ts
test("a scorer failure degrades to a warning and does not abort the scan", async () => {
  // Arrange a scan that sources >=1 posting, with a scorer that throws on score().
  const throwingScorer = { score: async () => { throw new Error("LLM exploded"); } };
  // Use the file's existing runScan harness/deps builder; swap in throwingScorer.
  await expect(runScan({ /* ...deps..., */ scorer: throwingScorer })).resolves.toBeDefined();
  // And the scan still recorded its sourcing outcome (postings persisted).
  // Assert via the repo that postings exist / scan finished — use the harness's repo handle.
});
```

Adapt to the file's actual `runScan` deps shape (do not invent a signature — read the existing tests first). The key assertion: `runScan` **resolves** (does not reject) when the scorer throws.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/cli/commands.test.ts -t "scorer failure"`
Expected: FAIL — the unguarded `Promise.all` currently rejects, so `runScan` rejects.

- [ ] **Step 3: Implement the guard.** Wrap the per-posting work so one failure warns and continues (`commands.ts:337-343`):

```ts
const scoreLimit = pLimit(SCORE_CONCURRENCY);
await Promise.all(
  sourced.postings.map((posting) =>
    scoreLimit(async () => {
      try {
        repo.saveMatchResult(posting.id, await deps.scorer.score(deps.profile, posting));
      } catch (error) {
        // Failures degrade, never crash: sourcing already committed; a single posting's scoring
        // failure must not abort the scan (mirrors recordScanFailures below).
        log(style.warn(`  ! Failed to score posting ${posting.id}: ${errorMessage(error)}`));
      }
    }),
  ),
);
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/cli/commands.test.ts -t "scorer failure"`
Expected: PASS. Then run the whole file to ensure no regression: `npx vitest run src/cli/commands.test.ts`.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck` then `./node_modules/.bin/biome check src/cli/commands.ts src/cli/commands.test.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands.ts src/cli/commands.test.ts
git commit -m "fix(scan): scoring failure degrades to a warning instead of aborting the scan"
```

---

### Task 6: Index `companies.last_seen_at` (Finding #6, Important)

Add the missing index on the exact column the incremental-scan hot path range-scans, in both schemas.

**Files:**
- Modify: `src/storage/schema.ts` (the `INDEXES` string, ~lines 96-102)
- Modify: `src/backend/schema.sql` (index block, ~lines 46-48)
- Test: `src/storage/repository.test.ts` (assert the index exists)

**Interfaces:**
- Consumes: `companies.last_seen_at` column (exists in both schemas).
- Produces: index `idx_companies_last_seen_at` (SQLite) / `companies_last_seen_at_idx` (PG).

- [ ] **Step 1: Write a failing test** in `src/storage/repository.test.ts`. A `Repository` runs `migrate()` in its constructor, which creates `INDEXES`. Assert the new index is present:

```ts
test("migrate creates an index on companies.last_seen_at (incremental-scan hot path)", () => {
  const dbPath = /* the file's temp-db helper */;
  const repo = new Repository(dbPath);
  const raw = /* open the same db file with better-sqlite3, as other tests in this file do */;
  const indexes = raw.prepare("PRAGMA index_list('companies')").all() as { name: string }[];
  expect(indexes.some((i) => i.name === "idx_companies_last_seen_at")).toBe(true);
  repo.close();
});
```

Use the file's existing temp-db + raw-handle pattern (see the Task-10 lint note in the prior session — `repository.test.ts` already opens raw handles). Do not hard-code the db path literally; use the helper.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/storage/repository.test.ts -t "last_seen_at"`
Expected: FAIL — index does not exist yet.

- [ ] **Step 3: Add the indexes.**
  - `src/storage/schema.ts`, append to `INDEXES` (and update the leading comment to mention `last_seen_at`: `listFreshCompanyUrls`):
    ```sql
    CREATE INDEX IF NOT EXISTS idx_companies_last_seen_at ON companies(last_seen_at);
    ```
  - `src/backend/schema.sql`, near the other company indexes (~line 77-79):
    ```sql
    -- listFreshCompanyUrls range-scans last_seen_at on every incremental scan.
    create index if not exists companies_last_seen_at_idx on companies (last_seen_at);
    ```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/storage/repository.test.ts -t "last_seen_at"`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck` then `./node_modules/.bin/biome check src/storage/schema.ts src/backend/schema.sql src/storage/repository.test.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/storage/schema.ts src/backend/schema.sql src/storage/repository.test.ts
git commit -m "perf(db): index companies.last_seen_at for the incremental-scan hot path"
```

---

### Task 7: DB-outcome assertion on the incremental invariant (Finding #7, Important)

Strengthen the incremental-scan regression test so it asserts the skipped company's posting is actually still live in the DB, not just that expiry spies weren't called.

**Files:**
- Modify: `src/cli/commands.test.ts` (~lines 696-776, the incremental invariant test)

**Interfaces:**
- Consumes: the existing test harness's `repo` handle + `repo.listScoredPostings(minScore, { includeExpired })`.
- Produces: nothing — test-only strengthening.

- [ ] **Step 1: Read the existing test** at `commands.test.ts:696`. Identify the "Fresh Co" company and its seeded posting id, and the harness's `repo` reference.

- [ ] **Step 2: Add a DB-outcome assertion** to the existing test (this is a strengthening, not a new test — the RED here is conceptual: prove the assertion is meaningful by confirming it passes with the current correct behavior and would fail if expiry wrongly ran). After the existing spy/`expired === 0` assertions, add:

```ts
// The mechanism assertions above prove expiry wasn't *called*; this proves the skipped
// company's live posting is actually still present and unexpired in the DB afterward.
const live = repo.listScoredPostings(0, { includeExpired: false });
expect(live.some((p) => p.posting.id === /* Fresh Co's seeded posting id */)).toBe(true);
```

Use the actual seeded id/variable from the test — do NOT hard-code a literal that mirrors the implementation; reference the same constant the test used to seed the row.

- [ ] **Step 3: Run to verify it passes with correct behavior**

Run: `npx vitest run src/cli/commands.test.ts -t "incremental"` (adapt `-t` to the test's actual name)
Expected: PASS.

- [ ] **Step 4: Prove the assertion has teeth** (temporary RED): temporarily make the test seed the Fresh Co posting as already-expired OR temporarily force an expiry call, confirm the new assertion FAILS, then revert. Document in the report that you verified the assertion fails when the invariant is violated. Do not commit the temporary change.

- [ ] **Step 5: Lint**

Run: `./node_modules/.bin/biome check src/cli/commands.test.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands.test.ts
git commit -m "test(scan): assert skipped company's posting stays live on incremental scan"
```

---

### Task 8: Memoize MatchCard (Finding #8, Important)

Stop one optimistic action re-rendering the whole match list.

**Files:**
- Modify: `web/src/views/Matches.tsx` (`MatchCard`, ~lines 53-158)
- Test: `web/src/views/Matches.test.tsx` (behavioral — the list still works; memoization is a perf optimization, so test that behavior is unchanged, not render counts)

**Interfaces:**
- Consumes: `ScoredPosting`, `useMatchAction`.
- Produces: a memoized `MatchCard` — same props, same behavior.

- [ ] **Step 1: Confirm behavior is covered.** Read `Matches.test.tsx`. If save/dismiss/apply interactions are already tested, no new behavioral test is needed — memoization must not change behavior, and the existing tests are the guard. If they're NOT covered, add one interaction test (click Save → optimistic state flips) so the wrap is protected. Do not assert render counts (brittle).

- [ ] **Step 2: Wrap `MatchCard` in `React.memo`.** `MatchCard` receives `ScoredPosting & { countryFilterActive: boolean }`. Its props are the posting/result/action objects (stable identities from the query cache except the one that changed) plus a boolean. Wrap:

```tsx
import { memo } from "react";
// ...
const MatchCard = memo(function MatchCard({ posting, result, action, expired, countryFilterActive }: ScoredPosting & { countryFilterActive: boolean }) {
  // ...unchanged body...
});
```

The inline arrow `onClick` handlers are fine to leave — `React.memo` compares props, and after an optimistic mutation only the touched card's `action` prop changes identity, so the others skip re-render. (The handlers close over `posting.id`/`action`, recreated per render, but they're not props to a memoized child, so they don't defeat the memo.)

- [ ] **Step 3: Run to verify pass**

Run: `npm run test:web -- Matches`
Expected: PASS (behavior unchanged).

- [ ] **Step 4: Typecheck + lint**

Run: `npm run typecheck:web` then `./node_modules/.bin/biome check web/src/views/Matches.tsx`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/views/Matches.tsx web/src/views/Matches.test.tsx
git commit -m "perf(web): memoize MatchCard so one action doesn't re-render the list"
```

---

### Task 9: Gate background status polling on tab visibility (Finding #9, Important)

Stop scan/score status hooks polling forever in background tabs, without losing the deliberate keep-mounted view-state preservation.

**Files:**
- Modify: `web/src/hooks.ts` (`useScanStatus`, `useScoreStatus`)
- Modify: `web/src/App.tsx` (expose the active tab) + `web/src/views/Home.tsx` / `Companies.tsx` (pass an `enabled`/active signal)
- Test: `web/src/hooks.test.ts` or view tests

**Interfaces:**
- Consumes: TanStack Query `refetchInterval`. The existing hooks poll at 1s while `state === "running"`.
- Produces: `useScanStatus(options?: { enabled?: boolean })` / `useScoreStatus(options?: { enabled?: boolean })` — when `enabled === false`, polling is suppressed (`refetchInterval: false`) but the last data remains readable.

**Design note:** the cleanest minimal change is to add an `enabled`-style gate to the polling interval, driven by whether the owning tab is active. `App.tsx` already knows the active `tab`. Pass `active={tab === "Home"}` into `Home` and `active={tab === "Companies"}` into `Companies`, and thread it to the status hooks so `refetchInterval` returns `false` when the tab isn't active. Do NOT unmount tabs (that breaks the documented view-state preservation at `App.tsx:91-92`). Keep the query itself mounted; only suppress the interval.

- [ ] **Step 1: Write a failing test.** In `web/src/hooks.test.ts` (or a view test), assert that when the owning tab is inactive, the status query does not schedule refetches. Testing `refetchInterval` directly is awkward; instead test the observable: with `enabled: false`, advancing timers does not trigger additional `fetch` calls. Use `vi.useFakeTimers()` + the file's fetch mock:

```ts
test("useScanStatus does not poll when its tab is inactive", async () => {
  // Render a component using useScanStatus({ enabled: false }) with a running-state fetch mock.
  // Advance timers by several seconds; assert fetch was called at most once (initial), not on an interval.
});
```

Adapt to the file's existing hook-testing harness (renderHook + QueryClientProvider). If `hooks.test.ts` doesn't exist, add the assertion at the view level in `Home.test.tsx` instead.

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:web -- hooks` (or the chosen file)
Expected: FAIL — polling currently runs regardless of tab.

- [ ] **Step 3: Implement.**
  - In `hooks.ts`, give `useScanStatus`/`useScoreStatus` an optional `{ enabled = true }` and make `refetchInterval` a function that returns `false` when `!enabled` OR state isn't running:
    ```ts
    export function useScanStatus({ enabled = true }: { enabled?: boolean } = {}) {
      return useQuery({
        queryKey: ["scan-status"],
        queryFn: fetchScanStatus,
        refetchInterval: (query) =>
          enabled && query.state.data?.state === "running" ? 1000 : false,
      });
    }
    ```
    (Match the existing hook's actual key/queryFn names; only the `refetchInterval` gains the `enabled` guard.)
  - In `App.tsx`, pass the active flag: `<Home active={tab === "Home"} />`, `<Companies active={tab === "Companies"} />`.
  - In `Home.tsx`/`Companies.tsx`, accept `active` and pass `{ enabled: active }` to the status hooks. Where a component calls the hook only to read data (e.g. `DeepScoreCard`'s second `useScoreStatus`), pass `{ enabled: active }` too — reading cached data still works when the interval is off.

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:web -- hooks Home Companies`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck:web` then `./node_modules/.bin/biome check web/src/hooks.ts web/src/App.tsx web/src/views/Home.tsx web/src/views/Companies.tsx`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/hooks.ts web/src/App.tsx web/src/views/Home.tsx web/src/views/Companies.tsx web/src/hooks.test.ts
git commit -m "perf(web): pause scan/score status polling on inactive tabs"
```

---

### Task 10: Convert CLI parseArgs throws to styled errors (Finding #12, Important)

Unknown flags and dash-leading positionals should return the CLI's `{ kind: "help", error }` shape, not a raw Node `TypeError`.

**Files:**
- Modify: `src/cli/parse.ts` (`parseCli`)
- Test: `src/cli/parse.test.ts`

**Interfaces:**
- Consumes: `parseArgs` (node:util), which throws `TypeError` with `.code` like `ERR_PARSE_ARGS_UNKNOWN_OPTION` on bad input.
- Produces: `parseCli` never throws for user-input errors — it returns `{ kind: "help", error }`.

- [ ] **Step 1: Write failing tests** in `src/cli/parse.test.ts`:

```ts
test("unknown flag returns a help error, not a throw", () => {
  const cmd = parseCli(["scan", "--freshnes-hours", "6"]);
  expect(cmd.kind).toBe("help");
  if (cmd.kind === "help") expect(cmd.error).toMatch(/unknown|--freshnes-hours/i);
});

test("dash-leading resume path returns a help error, not a throw", () => {
  const cmd = parseCli(["profile", "--resume-2026.pdf"]);
  expect(cmd.kind).toBe("help");
  if (cmd.kind === "help") expect(cmd.error).toBeTruthy();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/cli/parse.test.ts -t "unknown flag"`
Expected: FAIL — `parseCli` currently throws `TypeError` out of `parseArgs`.

- [ ] **Step 3: Implement.** Wrap the `parseArgs` calls so a thrown parser error becomes a help result. The cleanest minimal approach: a small helper that runs `parseArgs` and, on throw, returns a sentinel the switch converts to `{ kind: "help", error }`. Given each `case` calls `parseArgs` differently, wrap the whole `switch` body's parseArgs usage — simplest is a try/catch around the per-command parse:

```ts
function safeParse<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
```

Then in each `case` that uses `parseArgs`, wrap:

```ts
case "scan": {
  const parsed = safeParse(() =>
    parseArgs({ args: rest, options: { /* ... */ }, allowPositionals: true }),
  );
  if (!parsed.ok) return { kind: "help", error: parsed.error };
  const { values } = parsed.value;
  // ...rest unchanged...
}
```

Apply to every `case` invoking `parseArgs` (scan, score, list, serve, profile — read the file for the full set). Keep the existing domain validation (e.g. the `--freshness-hours` integer check) unchanged after the safe-parse.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/cli/parse.test.ts`
Expected: PASS (new + all existing parse tests, including the `--freshness-hours 0` / `--min-score 0` explicit-value cases — do NOT regress those).

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck` then `./node_modules/.bin/biome check src/cli/parse.ts src/cli/parse.test.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/cli/parse.ts src/cli/parse.test.ts
git commit -m "fix(cli): surface a styled error for unknown flags instead of a raw parser throw"
```

---

### Task 11: Document `list` filter flags (Finding #13, Important)

`list`'s real, tested flags are invisible in `--help`.

**Files:**
- Modify: `src/cli/help.ts` (the `list` entry in `COMMANDS`, ~lines 72-79)
- Test: `src/cli/help.test.ts` (if it exists; else assert via `renderHelp`)

**Interfaces:**
- Consumes: nothing.
- Produces: updated help text for `list`.

- [ ] **Step 1: Write a failing test.** If `src/cli/help.test.ts` exists, add; else create a minimal one:

```ts
import { renderHelp } from "./help";
test("list help documents all its filter flags", () => {
  const help = renderHelp("list");
  for (const flag of ["--min-score", "--remote-only", "--country", "--only-applied", "--include-applied"]) {
    expect(help).toContain(flag);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/cli/help.test.ts`
Expected: FAIL — only `--min-score` is documented.

- [ ] **Step 3: Implement.** Update the `list` entry in `COMMANDS`:

```ts
{
  name: "list",
  invocation: "list [--min-score N] [--remote-only] [--country CC] [--only-applied] [--include-applied]",
  summary: "Show stored matches (default min score 50)",
  details: "Prints stored matches, highest score first. Expired and dismissed postings are hidden.",
  options: [
    ["--min-score N", "Only show matches scoring at least N (default 50)."],
    ["--remote-only", "Only show roles detected as remote."],
    ["--country CC", "Only show roles in the given country (plus roles whose country is unknown)."],
    ["--only-applied", "Only show roles you've marked applied."],
    ["--include-applied", "Include applied roles (hidden by default)."],
  ],
  examples: ["job-hunter list", "job-hunter list --min-score 70 --remote-only"],
},
```

Verify the flag descriptions against `parse.ts`'s actual `list` handling (lines ~112-134) — match the real semantics (e.g. whether `--country` also keeps unknowns, per `Matches.tsx:63-65` behavior).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/cli/help.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `./node_modules/.bin/biome check src/cli/help.ts src/cli/help.test.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/cli/help.ts src/cli/help.test.ts
git commit -m "docs(cli): document list's remote/country/applied filter flags in --help"
```

---

### Task 12: Non-color signal for expired postings (Finding #10, Important)

Expired postings must be distinguishable without relying on opacity/color (WCAG 1.4.1).

**Files:**
- Modify: `web/src/views/Matches.tsx` (`MatchCard`, the expired badge ~line 99-101 and the title ~line 71-78)
- Test: `web/src/views/Matches.test.tsx`

**Interfaces:**
- Consumes: `expired: boolean` prop.
- Produces: an expired card with a non-color affordance (icon/text prefix + border), not opacity alone.

- [ ] **Step 1: Write a failing test.** Assert an expired card exposes a text/structural signal beyond the dimming class:

```tsx
test("expired postings carry a non-color signal (accessible label)", () => {
  // render Matches with one expired posting (includeExpired true, seeded expired row)
  // the expired badge should have an accessible name / the title an indicator
  const badge = screen.getByText(/expired/i);
  expect(badge).toBeInTheDocument();
  // stronger: the card exposes aria or a border marker, not opacity only
});
```

Refine the assertion to whatever concrete non-color marker you add in Step 3 (keep test + impl consistent).

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:web -- Matches`
Expected: FAIL for the new assertion.

- [ ] **Step 3: Implement.** Add a non-color signal to the expired card. Minimal, consistent with the existing Tailwind design tokens:
  - Give the expired badge a stronger structural presence: a border + a leading icon glyph (e.g. `⊘`) and an `aria-label`:
    ```tsx
    {expired ? (
      <span
        className="rounded-full border border-border bg-subtle px-2 py-0.5 text-xs text-muted"
        aria-label="This role has expired"
      >
        ⊘ expired
      </span>
    ) : null}
    ```
  - And add a left border to the whole card so the state is perceivable without reading the badge:
    ```tsx
    <Card className={expired ? "border-l-2 border-l-muted opacity-60" : ""}>
    ```
  Keep `opacity-60` as an *additional* cue, not the only one.

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:web -- Matches`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck:web` then `./node_modules/.bin/biome check web/src/views/Matches.tsx`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/views/Matches.tsx web/src/views/Matches.test.tsx
git commit -m "fix(a11y): give expired postings a non-color signal (border + labeled badge)"
```

---

### Task 13: aria-atomic on live status regions (Finding #11, Important)

Scan/score progress live regions must announce message+count together.

**Files:**
- Modify: `web/src/views/Home.tsx` (the `aria-live="polite"` divs, ~lines 149, 270)
- Test: `web/src/views/Home.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `aria-atomic="true"` on the progress live regions.

- [ ] **Step 1: Write a failing test.**

```tsx
test("scan progress live region is atomic", async () => {
  renderHome({ scanRunning: true }); // adapt to the file's running-state helper
  const region = await screen.findByText(/scanning|reading the directory|scoring/i);
  const live = region.closest("[aria-live]");
  expect(live).toHaveAttribute("aria-atomic", "true");
});
```

Adapt the selector to whichever live region wraps the running message. If both scan and score regions apply, test both.

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:web -- Home`
Expected: FAIL — regions lack `aria-atomic`.

- [ ] **Step 3: Implement.** Add `aria-atomic="true"` to each `aria-live="polite"` progress `div` in `Home.tsx` (the scan progress block ~line 149 and the score progress block ~line 270). Leave the transient info banners (e.g. "Waiting for the scan…" at 337) as-is unless they wrap a changing message+count pair.

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:web -- Home`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck:web` then `./node_modules/.bin/biome check web/src/views/Home.tsx`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/views/Home.tsx web/src/views/Home.test.tsx
git commit -m "fix(a11y): mark scan/score progress live regions aria-atomic"
```

---

### Task 14: Surface scan warnings on Home (Finding #14, Important)

A single-scan warning currently shows only a count; the failed-company detail is undiscoverable until 5 consecutive failures.

**Files:**
- Modify: `web/src/views/Home.tsx` (scan-done warning block ~lines 171-176)
- Possibly Read: `web/src/api.ts` (the scan-status `warnings` shape) + `web/src/hooks.ts`
- Test: `web/src/views/Home.test.tsx`

**Interfaces:**
- Consumes: the scan status `done` payload. Read `api.ts` for whether `warnings` (with per-company message/company) is present on the status shape; if it carries only a count, this task expands the surface to show the list IF available, else stays a count with a pointer to the Companies tab.
- Produces: an expandable warnings detail on Home when warning details exist.

- [ ] **Step 1: Read the contract.** Check `web/src/api.ts` for the scan-status schema — does `done`/status carry a `warnings: Warning[]` array (with `company`/`message`), or only a number? This determines the fix:
  - **If details are available:** render them in a `<details>`/expandable list on Home.
  - **If only a count is available:** the honest minimal fix is to make the count line link/point to the Companies tab ("2 warnings — see Companies") AND lower the "needs attention" surfacing threshold is out of scope; instead just add the pointer. Note the limitation in the report.

Decide based on the actual contract; do not assume.

- [ ] **Step 2: Write a failing test** matching the chosen approach. E.g. if details exist:

```tsx
test("scan warnings are expandable on Home", async () => {
  renderHome({ scanDone: { warnings: [{ company: "Acme", message: "board 500" }] } });
  await userEvent.click(screen.getByText(/warning/i));
  expect(screen.getByText(/Acme/)).toBeInTheDocument();
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm run test:web -- Home`
Expected: FAIL.

- [ ] **Step 4: Implement** the chosen approach in the scan-done block (~171-176). If rendering details, use a native `<details>` for zero-JS keyboard accessibility:

```tsx
{warnings.length > 0 ? (
  <details className="mt-2 text-sm">
    <summary className="cursor-pointer text-warning">
      {warnings.length} warning(s) — companies that didn't load
    </summary>
    <ul className="mt-1 list-disc pl-5 text-faint">
      {warnings.map((w) => (
        <li key={w.company ?? w.message}>{w.company ? `${w.company}: ` : ""}{w.message}</li>
      ))}
    </ul>
  </details>
) : null}
```

- [ ] **Step 5: Run to verify pass**

Run: `npm run test:web -- Home`
Expected: PASS.

- [ ] **Step 6: Typecheck + lint + commit**

Run: `npm run typecheck:web` then `./node_modules/.bin/biome check web/src/views/Home.tsx web/src/api.ts`

```bash
git add web/src/views/Home.tsx web/src/views/Home.test.tsx
git commit -m "feat(web): surface scan warning details on Home"
```

---

### Task 15: Confirm before removing a tracked company (Finding #15, Important)

A no-confirm "Remove" permanently untracks a company on a fat-finger.

**Files:**
- Modify: `web/src/views/Companies.tsx` (the Remove button ~lines 126-133)
- Test: `web/src/views/Companies.test.tsx`

**Interfaces:**
- Consumes: the existing untrack mutation.
- Produces: a two-step confirm affordance (inline confirm, NOT a `window.confirm` dialog — the browser-automation constraint aside, a native confirm is untestable in jsdom and blocks). Prefer an inline "Remove → Confirm?" toggle.

- [ ] **Step 1: Write a failing test.**

```tsx
test("removing a company requires a confirm click", async () => {
  renderCompanies({ tracked: [{ careersUrl: "https://acme.co", name: "Acme" }] });
  await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));
  // first click reveals a confirm; the untrack mutation has NOT fired yet
  expect(removeMutationSpy).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: /confirm/i }));
  expect(removeMutationSpy).toHaveBeenCalledWith(expect.objectContaining({ careersUrl: "https://acme.co" }));
});
```

Adapt `removeMutationSpy` to the file's mock of the untrack API.

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:web -- Companies`
Expected: FAIL — remove fires on first click.

- [ ] **Step 3: Implement** an inline confirm. Add per-row local state (a small child component or a `confirmingUrl` state in the list) so the first click swaps "Remove" for "Confirm? / Cancel":

```tsx
function RemoveButton({ onRemove, pending }: { onRemove: () => void; pending: boolean }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button variant="ghost" disabled={pending} onClick={() => setConfirming(true)}
        className="hover:text-danger focus-visible:ring-2">
        Remove
      </Button>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <Button variant="ghost" disabled={pending} onClick={onRemove} className="text-danger">Confirm</Button>
      <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
    </span>
  );
}
```

Wire it where the current Remove button is. Keep the `pending` disable.

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:web -- Companies`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint + commit**

Run: `npm run typecheck:web` then `./node_modules/.bin/biome check web/src/views/Companies.tsx`

```bash
git add web/src/views/Companies.tsx web/src/views/Companies.test.tsx
git commit -m "fix(web): confirm before removing a tracked company"
```

---

## Self-Review

**Spec coverage:** all 15 findings mapped to tasks — #1→T1, #2→T2+T3, #3→T4, #4→T3, #5→T5, #6→T6, #7→T7, #8→T8, #9→T9, #10→T12, #11→T13, #12→T10, #13→T11, #14→T14, #15→T15. ✓

**Type consistency:** `startScan(kind?: ScanScope)` (T2) matches the `ScanStore` interface at `scan-store.ts:24`. `recordDirectory(..., options?)` (T3) matches `scan-store.ts:25-29`. `HttpFetcher` deps object (T4) is additive/optional — no caller change. `useScanStatus({ enabled })` (T9) additive/optional. ✓

**Placeholder scan:** every code step shows real code; tests reference the file's existing harness (which the implementer must read) rather than inventing signatures — this is intentional, and each task's Step 1 instructs reading the existing test setup first. ✓

**Ordering:** T2 (kind column) precedes T3 (staleness uses kind) — dependency respected. T4 Step 1 refactor precedes its tests. All other tasks independent.

**Risk notes for the executor:**
- Postgres tasks (T2/T3): live SQL is smoke-only. The `fakeSql` approach unit-tests threading/shape; if it proves too fragile, fall back to shape-assertion-by-reading + a note, per the Global Constraints.
- T9 must NOT unmount tabs (breaks `App.tsx:91` view-state preservation) — gate the interval only.
- T7/T4 Step "prove it has teeth": temporary RED, revert before commit.

# Smart follow-up scanning for warned companies — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically retry per-company scan failures once within the same run, and persist any
still-failing after 5 consecutive scans into a "Needs attention" list — surfaced via a CLI
`--retry-failed` flag and a dashboard panel with a per-company rescan action.

**Architecture:** `discover()` gains a second, smaller fetch pass over just the leads that failed the
main pass (excluding source-level failures and the intentional unscrapable-host skip). `Warning`
gains an optional `careersUrl` field that marks a warning as a per-company (retryable) failure. A new
`failed_leads` SQLite table (local `Repository` only — never touches the shared `ScanStore`/Postgres
worker seam) tracks consecutive failures per company; `runScan()` in `src/cli/commands.ts` records
them after each scan. Once a company hits 5 consecutive failures it's excluded from future in-run
retry passes (still gets the normal main-pass attempt every scan) and appears in a "Needs attention"
list, rescannable via `job-hunter scan --retry-failed` or a dashboard button.

**Tech Stack:** TypeScript, better-sqlite3, Hono, React 19 + TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-01-retry-failed-companies-design.md`

## Global Constraints

- TypeScript-strict, ESM, ES2022; `noUncheckedIndexedAccess`, `noImplicitOverride` on.
- No `!` non-null assertions. No type assertions outside tests.
- No new runtime dependencies (reuse `p-limit`, already a dependency).
- Biome: 2-space indent, 100-col width, double quotes. Verify with `npm run lint` (full project
  scope, not a file subset) before each commit that touches lint-checked files.
- Tests colocated (`*.test.ts` next to source), offline, fixture-driven. Coverage gate: statements
  93 / branches 85 / functions 90 / lines 93 (`npm run test:coverage`).
- **Failures degrade, never crash** — a failure to persist `failed_leads` must not abort a scan.
- Conventional Commits. No Claude co-authored footer.
- Every task ends with `npm test` (or the narrower test file first, then the full suite) and
  `npm run typecheck` passing before moving to the next task.

---

### Task 1: `Warning` gains an optional `careersUrl`

**Files:**
- Modify: `src/domain/types.ts:35-38`
- Test: `src/discovery/discover.test.ts` (existing file — extend, see Task 2 for the retry-pass tests;
  this task only needs the type to compile, no new test of its own since `Warning` is a plain type)

**Interfaces:**
- Produces: `Warning` now has `{ source: string; message: string; careersUrl?: string }`. Every later
  task that reads/writes `Warning` relies on `careersUrl` being present only for per-company (retryable)
  failures — absent for source-level failures and the unscrapable-host skip notice.

- [ ] **Step 1: Update the type**

In `src/domain/types.ts`, replace:

```ts
export type Warning = {
  source: string;
  message: string;
};
```

with:

```ts
export type Warning = {
  source: string;
  message: string;
  /** The careers URL this warning is about, when it's a per-company fetch failure. Absent for
   * source-level failures (e.g. a lead source erroring) and the unscrapable-host skip notice —
   * those aren't retry targets. */
  careersUrl?: string;
};
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (the field is optional, so no existing `Warning` literal breaks).

- [ ] **Step 3: Commit**

```bash
git add src/domain/types.ts
git commit -m "feat(domain): mark per-company warnings with their careers URL"
```

---

### Task 2: In-run retry pass in `discover()`

**Files:**
- Modify: `src/discovery/discover.ts:177-193` (the post-fan-out warning/posting collection loop)
- Test: `src/discovery/discover.test.ts` (add new `describe("discover retry pass", ...)` block)

**Interfaces:**
- Consumes: `DiscoverDeps` (unchanged from Task 1's perspective — `skipRetryFor` is added in Task 5,
  not here, to keep this task's diff focused on the retry mechanism itself).
- Produces: `discover()`'s existing signature and `DiscoverResult` shape are unchanged. Per-company
  failure `Warning`s now carry `careersUrl`; source-level and unscrapable-host warnings still omit it.
  A lead that fails the main pass but succeeds on retry appears in `postings`, not `warnings`.

- [ ] **Step 1: Write the failing tests**

Add to `src/discovery/discover.test.ts`, inside a new `describe` block after the existing
`describe("discover", ...)` block (after line 215, before the "merges tracked companies..." test —
exact placement doesn't matter, tests are independent):

```ts
describe("discover retry pass", () => {
  it("retries a company that failed the main pass, and it succeeds this time", async () => {
    let renderCalls = 0;
    const renderer: PageRenderer = {
      async render(url) {
        if (url === "https://boom.com/careers") {
          renderCalls += 1;
          if (renderCalls === 1) throw new Error("render crashed");
          return JSONLD_HTML;
        }
        return JSONLD_HTML;
      },
    };
    const reader = new FakeSharedViewReader(
      airtableData([{ name: "Boom", url: "https://boom.com/careers" }]),
    );

    const { postings, warnings } = await discover({
      fetcher: new GaugedFetcher({}, new Gauge()),
      renderer,
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      delayMs: 0,
      settings: { getSetting: () => undefined },
      sources: [new AirtableSource()],
    });

    // Failed once, succeeded on retry — no warning, and the posting made it through.
    expect(renderCalls).toBe(2);
    expect(warnings).toHaveLength(0);
    expect(postings.map((p) => p.title)).toEqual(["Operations Lead"]);
  });

  it("keeps a per-company warning (with careersUrl) when a company fails both the main pass and the retry", async () => {
    const renderer: PageRenderer = {
      async render(url) {
        if (url === "https://boom.com/careers") throw new Error("render crashed");
        return JSONLD_HTML;
      },
    };
    const reader = new FakeSharedViewReader(
      airtableData([
        { name: "Boom", url: "https://boom.com/careers" },
        { name: "Initech", url: "https://initech.com/careers" },
      ]),
    );

    const { postings, warnings } = await discover({
      fetcher: new GaugedFetcher({}, new Gauge()),
      renderer,
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      delayMs: 0,
      settings: { getSetting: () => undefined },
      sources: [new AirtableSource()],
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.source).toBe("Boom");
    expect(warnings[0]?.careersUrl).toBe("https://boom.com/careers");
    // The other company's posting still comes through despite Boom's persistent failure.
    expect(postings.map((p) => p.title)).toEqual(["Operations Lead"]);
  });

  it("does not retry source-level failures or the unscrapable-host skip notice", async () => {
    const bad: LeadSource = {
      name: "bad-source",
      fetch: async () => ({ leads: [], warnings: [{ source: "bad-source", message: "boom" }] }),
    };
    const rendered: string[] = [];
    const renderer: PageRenderer = {
      async render(url) {
        rendered.push(url);
        return JSONLD_HTML;
      },
    };
    const reader = new FakeSharedViewReader(
      airtableData([
        { name: "BigCo", url: "https://www.linkedin.com/company/bigco/jobs/" },
        { name: "Initech", url: "https://initech.com/careers" },
      ]),
    );

    const { warnings } = await discover({
      fetcher: new GaugedFetcher({}, new Gauge()),
      renderer,
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      delayMs: 0,
      settings: { getSetting: () => undefined },
      sources: [bad, new AirtableSource()],
    });

    // Source-level failure has no careersUrl — never retried.
    const sourceWarning = warnings.find((w) => w.source === "bad-source");
    expect(sourceWarning?.careersUrl).toBeUndefined();
    // The unscrapable-host summary warning also has no careersUrl.
    const skipWarning = warnings.find((w) => w.source === "directory");
    expect(skipWarning?.careersUrl).toBeUndefined();
    // LinkedIn is never rendered (skip, not a failure) — only Initech's careers page renders once.
    expect(rendered).toEqual(["https://initech.com/careers"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/discovery/discover.test.ts -t "discover retry pass"`
Expected: FAIL — the first test fails because `renderCalls` never reaches 2 (no retry pass exists
yet, so a failed lead is never re-attempted); the second fails because `warnings[0]?.careersUrl` is
`undefined` (the field doesn't exist on the emitted warning yet).

- [ ] **Step 3: Implement the retry pass**

In `src/discovery/discover.ts`, replace the warning-collection loop (currently):

```ts
  for (const { lead, result } of collected) {
    if (!result.ok) {
      warnings.push({ source: lead.company, message: result.warning });
      continue;
    }
    for (const posting of result.postings) {
      byId.set(posting.id, posting);
    }
  }
```

with a version that separates failures out, retries them once, and only then reports the survivors:

```ts
  const failed: { lead: CompanyLead; result: Extract<ConnectorResult, { ok: false }> }[] = [];
  for (const { lead, result } of collected) {
    if (!result.ok) {
      failed.push({ lead, result });
      continue;
    }
    for (const posting of result.postings) {
      byId.set(posting.id, posting);
    }
  }

  if (failed.length > 0) {
    const retried = await Promise.all(
      failed.map(async ({ lead }) => {
        try {
          return { lead, result: await fetchLead(lead) };
        } catch (error) {
          return { lead, result: { ok: false, warning: errorMessage(error) } as ConnectorResult };
        }
      }),
    );
    for (const { lead, result } of retried) {
      if (!result.ok) {
        warnings.push({ source: lead.company, message: result.warning, careersUrl: lead.careersUrl });
        continue;
      }
      for (const posting of result.postings) {
        byId.set(posting.id, posting);
      }
    }
  }
```

This reuses `fetchLead` (already in scope) directly rather than the main pass's `limit`/`waitTurn` —
the retry set is always a small subset of `leads`, so it doesn't need the same concurrency governor;
running it as a plain `Promise.all` keeps the change minimal. `ConnectorResult`
(`src/discovery/connectors/types.ts:10`) is
`{ ok: true; postings: JobPosting[] } | { ok: false; warning: string }`, so
`Extract<ConnectorResult, { ok: false }>` resolves to `{ ok: false; warning: string }` as written
above — no adjustment needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/discovery/discover.test.ts`
Expected: PASS — all tests in the file, including the three new ones and all pre-existing ones (the
pre-existing "aggregates ATS + browser postings..." test at line 102 must still pass: it asserts
`warnings[0]?.source` is `"Boom"` with no expectation on `careersUrl`, which stays compatible since
the field is additive).

- [ ] **Step 5: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/discovery/discover.ts src/discovery/discover.test.ts
git commit -m "feat(discovery): retry per-company fetch failures once before reporting"
```

---

### Task 3: `failed_leads` table + `Repository` methods

**Files:**
- Modify: `src/storage/schema.ts` (add `failed_leads` table to the `SCHEMA` template string)
- Modify: `src/storage/repository.ts` (add `recordScanFailures`, `listNeedsAttention`,
  `listRetrySkipUrls`)
- Test: `src/storage/repository.test.ts` (new `describe("failed leads", ...)` block)

**Interfaces:**
- Consumes: `normalizeCareersUrl` from `@app/domain/normalize` (already imported in `repository.ts`).
- Produces:
  - `Repository.recordScanFailures(scanId: number, failures: { careersUrl: string; company: string; message: string }[]): void`
  - `Repository.listNeedsAttention(threshold?: number): { careersUrl: string; company: string; message: string; consecutiveFailures: number }[]` (default `threshold = 5`)
  - `Repository.listRetrySkipUrls(threshold?: number): string[]` (default `threshold = 5`, returns
    normalized careers URLs only)

- [ ] **Step 1: Write the failing tests**

Add to `src/storage/repository.test.ts`, as a new top-level `describe` block (place it after the
existing `describe("incremental scans — directory diff", ...)` block, before
`describe("incremental scans — posting expiry", ...)`):

```ts
describe("failed leads", () => {
  it("inserts a new row at consecutive_failures=1 on first failure", () => {
    const repo = newRepo();
    repo.recordScanFailures(1, [
      { careersUrl: "https://boom.com/careers", company: "Boom", message: "render crashed" },
    ]);
    expect(repo.listNeedsAttention(1)).toEqual([
      {
        careersUrl: "https://boom.com/careers",
        company: "Boom",
        message: "render crashed",
        consecutiveFailures: 1,
      },
    ]);
    repo.close();
  });

  it("increments consecutive_failures on repeated failure across scans", () => {
    const repo = newRepo();
    repo.recordScanFailures(1, [
      { careersUrl: "https://boom.com/careers", company: "Boom", message: "timeout" },
    ]);
    repo.recordScanFailures(2, [
      { careersUrl: "https://boom.com/careers", company: "Boom", message: "timeout again" },
    ]);
    const [row] = repo.listNeedsAttention(1);
    expect(row?.consecutiveFailures).toBe(2);
    expect(row?.message).toBe("timeout again");
    repo.close();
  });

  it("deletes the row when a previously-failing company recovers (absent from a later call)", () => {
    const repo = newRepo();
    repo.recordScanFailures(1, [
      { careersUrl: "https://boom.com/careers", company: "Boom", message: "timeout" },
    ]);
    repo.recordScanFailures(2, []); // Boom recovered — not in this scan's failure list
    expect(repo.listNeedsAttention(1)).toEqual([]);
    repo.close();
  });

  it("listNeedsAttention only returns rows at or above the threshold", () => {
    const repo = newRepo();
    for (let scanId = 1; scanId <= 3; scanId++) {
      repo.recordScanFailures(scanId, [
        { careersUrl: "https://boom.com/careers", company: "Boom", message: "timeout" },
      ]);
    }
    expect(repo.listNeedsAttention(5)).toEqual([]);
    expect(repo.listNeedsAttention(3)).toHaveLength(1);
    repo.close();
  });

  it("listRetrySkipUrls returns only the normalized URLs at or above the threshold", () => {
    const repo = newRepo();
    for (let scanId = 1; scanId <= 5; scanId++) {
      repo.recordScanFailures(scanId, [
        { careersUrl: "https://Boom.com/careers/", company: "Boom", message: "timeout" },
      ]);
    }
    expect(repo.listRetrySkipUrls(5)).toEqual(["https://boom.com/careers"]);
    repo.close();
  });

  it("normalizes careers URLs so casing/trailing-slash variants collapse to one row", () => {
    const repo = newRepo();
    repo.recordScanFailures(1, [
      { careersUrl: "https://Boom.com/careers/", company: "Boom", message: "a" },
    ]);
    repo.recordScanFailures(2, [
      { careersUrl: "https://boom.com/CAREERS", company: "Boom", message: "b" },
    ]);
    const rows = repo.listNeedsAttention(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.careersUrl).toBe("https://boom.com/careers");
    expect(rows[0]?.consecutiveFailures).toBe(2);
    repo.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/storage/repository.test.ts -t "failed leads"`
Expected: FAIL with `repo.recordScanFailures is not a function` (or similar) — the methods don't
exist yet.

- [ ] **Step 3: Add the table to the schema**

In `src/storage/schema.ts`, add to the `SCHEMA` template string (anywhere among the other
`CREATE TABLE IF NOT EXISTS` statements — e.g. right after the `tracked_companies` table):

```sql
CREATE TABLE IF NOT EXISTS failed_leads (
  careers_url TEXT PRIMARY KEY,
  company TEXT,
  message TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 1,
  last_failed_scan INTEGER NOT NULL
);
```

No `migrate()` entry is needed — `CREATE TABLE IF NOT EXISTS` runs on every `Repository`
construction (`this.db.exec(SCHEMA)` in the constructor), so both fresh and pre-existing databases
pick it up automatically.

- [ ] **Step 4: Implement the Repository methods**

In `src/storage/repository.ts`, add these three methods (near `recordDirectory`, since they follow
the same upsert/diff shape — after the `recordDirectory` method, before `startScan`... actually
`startScan` is defined above `recordDirectory`; place these new methods directly after
`recordDirectory`'s closing brace):

```ts
  /**
   * Record this scan's per-company failures (final, post-retry warnings with a `careersUrl`).
   * A company already in `failed_leads` gets its `consecutive_failures` incremented and message
   * updated; a new failure is inserted at 1. Any company NOT in `failures` that currently has a row
   * is deleted — it recovered, so its failure history is cleared rather than kept stale.
   */
  recordScanFailures(
    scanId: number,
    failures: { careersUrl: string; company: string; message: string }[],
  ): void {
    const normalized = failures.map((f) => ({ ...f, careersUrl: normalizeCareersUrl(f.careersUrl) }));
    const currentUrls = new Set(normalized.map((f) => f.careersUrl));

    const existing = this.db.prepare("SELECT careers_url FROM failed_leads").all() as {
      careers_url: string;
    }[];
    const toDelete = existing.filter((e) => !currentUrls.has(e.careers_url));

    const upsert = this.db.prepare(
      `INSERT INTO failed_leads (careers_url, company, message, consecutive_failures, last_failed_scan)
       VALUES (@careersUrl, @company, @message, 1, @scanId)
       ON CONFLICT(careers_url) DO UPDATE SET
         company = excluded.company,
         message = excluded.message,
         consecutive_failures = failed_leads.consecutive_failures + 1,
         last_failed_scan = excluded.last_failed_scan`,
    );
    const del = this.db.prepare("DELETE FROM failed_leads WHERE careers_url = ?");

    const transaction = this.db.transaction(() => {
      for (const row of toDelete) del.run(row.careers_url);
      for (const f of normalized) upsert.run({ ...f, scanId });
    });
    transaction();
  }

  /** Companies with `consecutive_failures >= threshold`, for the "Needs attention" CLI/UI surfaces. */
  listNeedsAttention(
    threshold = 5,
  ): { careersUrl: string; company: string; message: string; consecutiveFailures: number }[] {
    const rows = this.db
      .prepare(
        `SELECT careers_url, company, message, consecutive_failures FROM failed_leads
         WHERE consecutive_failures >= ? ORDER BY consecutive_failures DESC, careers_url`,
      )
      .all(threshold) as {
      careers_url: string;
      company: string | null;
      message: string;
      consecutive_failures: number;
    }[];
    return rows.map((row) => ({
      careersUrl: row.careers_url,
      company: row.company ?? row.careers_url,
      message: row.message,
      consecutiveFailures: row.consecutive_failures,
    }));
  }

  /** Just the normalized URLs at/over `threshold` — for `discover()`'s retry pass to skip. */
  listRetrySkipUrls(threshold = 5): string[] {
    return this.listNeedsAttention(threshold).map((row) => row.careersUrl);
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/storage/repository.test.ts`
Expected: PASS — all tests in the file.

- [ ] **Step 6: Full suite + typecheck + lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS, 0 failures, 0 lint errors.

- [ ] **Step 7: Commit**

```bash
git add src/storage/schema.ts src/storage/repository.ts src/storage/repository.test.ts
git commit -m "feat(storage): track consecutive per-company scan failures"
```

---

### Task 4: `discover()` accepts `skipRetryFor`

**Files:**
- Modify: `src/discovery/discover.ts` (the retry-pass code added in Task 2)
- Test: `src/discovery/discover.test.ts` (extend the `describe("discover retry pass", ...)` block)

**Interfaces:**
- Consumes: nothing new (this task only extends `DiscoverDeps`).
- Produces: `DiscoverDeps` gains `skipRetryFor?: Set<string>` (normalized careers URLs). A lead whose
  normalized `careersUrl` is in this set is excluded from the retry pass (Task 2's added code) but
  still gets the normal main-pass attempt.

- [ ] **Step 1: Write the failing test**

Add to the `describe("discover retry pass", ...)` block in `src/discovery/discover.test.ts`:

```ts
  it("skips the retry pass for a company in skipRetryFor, but still attempts it on the main pass", async () => {
    let renderCalls = 0;
    const renderer: PageRenderer = {
      async render(url) {
        if (url === "https://boom.com/careers") {
          renderCalls += 1;
          throw new Error("render crashed");
        }
        return JSONLD_HTML;
      },
    };
    const reader = new FakeSharedViewReader(
      airtableData([{ name: "Boom", url: "https://boom.com/careers" }]),
    );

    const { warnings } = await discover({
      fetcher: new GaugedFetcher({}, new Gauge()),
      renderer,
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      delayMs: 0,
      settings: { getSetting: () => undefined },
      sources: [new AirtableSource()],
      skipRetryFor: new Set(["https://boom.com/careers"]),
    });

    // Attempted once (main pass) — the retry pass skipped it, so renderCalls stops at 1.
    expect(renderCalls).toBe(1);
    expect(warnings[0]?.careersUrl).toBe("https://boom.com/careers");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/discovery/discover.test.ts -t "skips the retry pass"`
Expected: FAIL — `skipRetryFor` isn't a recognized property yet (either a TS error if run through
`vitest` with type-checking, or the retry pass runs unconditionally and `renderCalls` ends up `2`).

- [ ] **Step 3: Implement**

In `src/discovery/discover.ts`, add to `DiscoverDeps` (after `sources?: LeadSource[];`):

```ts
  /** Normalized careers URLs to exclude from the retry pass (still attempted on the main pass). */
  skipRetryFor?: Set<string>;
```

Then, in the retry-pass code from Task 2, filter `failed` before retrying:

```ts
  if (failed.length > 0) {
    const skip = deps.skipRetryFor ?? new Set<string>();
    const toRetry = failed.filter((f) => !skip.has(normalizeCareersUrl(f.lead.careersUrl)));
    const retried = await Promise.all(
      toRetry.map(async ({ lead }) => {
        try {
          return { lead, result: await fetchLead(lead) };
        } catch (error) {
          return { lead, result: { ok: false, warning: errorMessage(error) } as ConnectorResult };
        }
      }),
    );
    const retriedUrls = new Set(toRetry.map((f) => f.lead.careersUrl));
    for (const { lead, result } of retried) {
      if (!result.ok) {
        warnings.push({ source: lead.company, message: result.warning, careersUrl: lead.careersUrl });
        continue;
      }
      for (const posting of result.postings) {
        byId.set(posting.id, posting);
      }
    }
    // Anything skipped (in skipRetryFor) keeps its original main-pass warning.
    for (const { lead, result } of failed) {
      if (retriedUrls.has(lead.careersUrl)) continue;
      warnings.push({ source: lead.company, message: result.warning, careersUrl: lead.careersUrl });
    }
  }
```

This replaces Task 2's `if (failed.length > 0) { ... }` block in full — it is not an addition
alongside it. The code above is the complete, final version of that block: `toRetry` holds the
subset actually retried; `retriedUrls` marks which leads went through the retry loop; the final
`for (const { lead, result } of failed)` loop pushes exactly one warning for every lead that is
*not* in `retriedUrls` (i.e., every lead in `skipRetryFor`), using its original main-pass failure
result. Every lead in `failed` ends up with exactly one `warnings.push` call: either from the retry
loop (if retried) or from this closing loop (if skipped) — never both, never zero.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/discovery/discover.test.ts`
Expected: PASS — all tests, including Task 2's and this task's.

- [ ] **Step 5: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/discovery/discover.ts src/discovery/discover.test.ts
git commit -m "feat(discovery): let callers exclude known-bad companies from the retry pass"
```

---

### Task 5: Wire persistence + skip-list into `runScan`

**Files:**
- Modify: `src/cli/commands.ts` (`runSourcing`'s `SourcingOutcome`, `runScan`)
- Test: `src/cli/commands.test.ts` (extend `describe("runScan + listMatches", ...)`)

**Interfaces:**
- Consumes: `Repository.recordScanFailures`, `Repository.listRetrySkipUrls` (Task 3);
  `DiscoverDeps.skipRetryFor` (Task 4); `Warning.careersUrl` (Task 1).
- Produces: `SourcingOutcome` gains `scanId: number`. `runScan()` populates
  `discoverDeps.skipRetryFor` from `repo.listRetrySkipUrls()` before discovery, and calls
  `repo.recordScanFailures()` after discovery with the per-company (`careersUrl`-bearing) warnings.

- [ ] **Step 1: Write the failing test**

Add to `src/cli/commands.test.ts`, inside `describe("runScan + listMatches", ...)`:

```ts
  it("records per-company failures for later retry, and excludes known-bad companies from the retry pass", async () => {
    const repo = newRepo();
    let renderCalls = 0;
    const renderer: PageRenderer = {
      async render(url) {
        if (url === "https://boom.com/careers") {
          renderCalls += 1;
          throw new Error("render crashed");
        }
        return "";
      },
    };

    // Seed a company already at the retry-skip threshold from a prior run.
    for (let scanId = 1; scanId <= 5; scanId++) {
      repo.recordScanFailures(scanId, [
        { careersUrl: "https://boom.com/careers", company: "Boom", message: "prior failure" },
      ]);
    }

    await runScan(
      {
        repo,
        profile,
        scorer: new HeuristicScorer(),
        discoverDeps: {
          fetcher: new RouteFetcher({}),
          renderer,
          sharedViewReader: new FakeSharedViewReader(
            airtableData([{ name: "Boom", url: "https://boom.com/careers" }]),
          ),
          shareUrl: "https://airtable.com/appX/shrX/tblX",
          delayMs: 0,
          settings: { getSetting: () => undefined },
          sources: [new AirtableSource()],
        },
      },
      capture().log,
    );

    // Already known-bad (>=5 consecutive failures): attempted once (main pass), retry pass skipped.
    expect(renderCalls).toBe(1);
    // Still in the needs-attention list (this scan's failure is recorded, count keeps climbing).
    const attention = repo.listNeedsAttention(5);
    expect(attention).toHaveLength(1);
    expect(attention[0]?.consecutiveFailures).toBe(6);
    repo.close();
  });

  it("clears a company's failure history once it succeeds again", async () => {
    const repo = newRepo();
    repo.recordScanFailures(1, [
      { careersUrl: "https://boards.greenhouse.io/acme", company: "Acme", message: "timeout" },
    ]);

    await runScan(
      {
        repo,
        profile,
        scorer: new HeuristicScorer(),
        discoverDeps: {
          fetcher: new RouteFetcher({
            "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": JSON.stringify({
              jobs: [],
            }),
          }),
          renderer: new NullRenderer(),
          sharedViewReader: new FakeSharedViewReader(
            airtableData([{ name: "Acme", url: "https://boards.greenhouse.io/acme" }]),
          ),
          shareUrl: "https://airtable.com/appX/shrX/tblX",
          delayMs: 0,
          settings: { getSetting: () => undefined },
          sources: [new AirtableSource()],
        },
      },
      capture().log,
    );

    expect(repo.listNeedsAttention(1)).toEqual([]);
    repo.close();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/cli/commands.test.ts -t "records per-company failures"`
Run: `npx vitest run src/cli/commands.test.ts -t "clears a company's failure history"`
Expected: FAIL — `runScan` doesn't yet call `recordScanFailures` or thread `skipRetryFor`, so
`renderCalls` is 2 (both main pass and an unfiltered retry pass attempt it) in the first test, and
`listNeedsAttention` still returns the stale row in the second.

- [ ] **Step 3: Implement**

In `src/cli/commands.ts`:

1. Add `scanId: number` to `SourcingOutcome` (the type definition around line 108):

```ts
export type SourcingOutcome = {
  scanId: number;
  postings: JobPosting[];
  companies: CompanyLead[];
  warnings: Warning[];
  newCompanies: CompanyRef[];
  removedCompanies: CompanyRef[];
  expired: number;
};
```

2. In `runSourcing`, thread the already-open `scanId` into the return (the function already opens
   `const scanId = await repo.startScan();` at the top — just add it to the final return statement):

```ts
  return { scanId, postings, companies, warnings, expired, ...diff };
```

3. In `runScan`, before calling `runSourcing`, populate `skipRetryFor` on the passed `discoverDeps`:

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

4. After scoring finishes (after the `Promise.all` scoring block, before the `onProgress?.({ kind:
   "summary", ... })` line), record this scan's per-company failures:

```ts
  const perCompanyFailures = sourced.warnings
    .filter((w): w is Warning & { careersUrl: string } => w.careersUrl !== undefined)
    .map((w) => ({ careersUrl: w.careersUrl, company: w.source, message: w.message }));
  try {
    repo.recordScanFailures(sourced.scanId, perCompanyFailures);
  } catch (error) {
    // Failures degrade, never crash: the scan itself already succeeded by this point.
    log(style.warn(`  ! Failed to record scan-failure history: ${errorMessage(error)}`));
  }
```

   `commands.ts` does not currently import `errorMessage` — add
   `import { errorMessage } from "@app/net/error-message";` to its import block (alongside the
   existing `import pLimit from "p-limit";` line is a reasonable spot, keeping named imports grouped
   above the default import per the file's existing order).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/cli/commands.test.ts`
Expected: PASS — all tests in the file.

- [ ] **Step 5: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. Pay attention to `src/backend/scanner/run-once.test.ts` — it consumes
`SourcingOutcome` indirectly through `runSourcing`; confirm it doesn't assert an exact-shape
equality that breaks on the new `scanId` field (per the spec's noted risk). If it does, update that
test's expected-shape assertion to include `scanId` (a `number`) rather than loosening the check.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands.ts src/cli/commands.test.ts
git commit -m "feat(cli): persist per-company scan failures and skip known-bad retries"
```

---

### Task 6: CLI `--retry-failed` flag

**Files:**
- Modify: `src/cli/parse.ts` (the `"scan"` case, `Command` type)
- Modify: `src/cli/main.ts` (`runScanCommand`, the `case "scan":` dispatch)
- Test: `src/cli/parse.test.ts`, `src/cli/main.test.ts`

**Interfaces:**
- Consumes: `Repository.listNeedsAttention` (Task 3).
- Produces: `parseCli(["scan", "--retry-failed"])` → `{ kind: "scan", retryFailed: true }`.
  `runScanCommand(repo, log, retryFailed)` — when `retryFailed` is true, scopes discovery to just
  `repo.listNeedsAttention()`'s companies via `trackedCompanies` + `sources: []` (mirroring
  `sourceFromFeedAndTracked`'s existing scoped-crawl pattern), and short-circuits with a message if
  that list is empty.

- [ ] **Step 1: Write the failing tests**

In `src/cli/parse.test.ts`, near the existing `it("parses scan", ...)` test (line 5-7):

```ts
  it("parses scan with --retry-failed", () => {
    expect(parseCli(["scan", "--retry-failed"])).toEqual({ kind: "scan", retryFailed: true });
  });

  it("parses bare scan with retryFailed defaulting to false", () => {
    expect(parseCli(["scan"])).toEqual({ kind: "scan", retryFailed: false });
  });
```

In `src/cli/main.test.ts`, inside `describe("scan command", ...)`:

```ts
  it("--retry-failed scopes discovery to the needs-attention list only", async () => {
    seedProfile();
    const repo = openDb();
    for (let scanId = 1; scanId <= 5; scanId++) {
      repo.recordScanFailures(scanId, [
        { careersUrl: "https://boom.com/careers", company: "Boom", message: "timeout" },
      ]);
    }
    repo.close();
    h.postings = [posting("1")];

    await runCli("scan", "--retry-failed");

    expect(logged()).toContain("Scanned and scored 1");
  });

  it("--retry-failed with an empty needs-attention list is a no-op", async () => {
    seedProfile();

    await runCli("scan", "--retry-failed");

    expect(logged()).toContain("Nothing needs attention");
  });
```

Note: `main.test.ts` mocks `@app/discovery/discover` wholesale (line 25-27 in the current file), so
this test can't assert *which* companies were crawled — it only proves the flag routes through
without erroring and (for the empty-list case) short-circuits with the expected message. The deeper
"only crawls needs-attention companies" behavior is implicitly covered by Task 5's `commands.test.ts`
tests, which exercise the real `discover()`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/cli/parse.test.ts -t "retry-failed"`
Run: `npx vitest run src/cli/main.test.ts -t "retry-failed"`
Expected: FAIL — `parseCli(["scan"])` currently returns `{ kind: "scan" }` with no `retryFailed`
field; `runCli("scan", "--retry-failed")` currently ignores the extra arg and runs a normal scan.

- [ ] **Step 3: Implement `parse.ts`**

In `src/cli/parse.ts`, change the `Command` type's `scan` variant:

```ts
  | { kind: "scan"; retryFailed: boolean }
```

And the `case "scan":` branch:

```ts
    case "scan": {
      const { values } = parseArgs({
        args: rest,
        options: { "retry-failed": { type: "boolean" } },
        allowPositionals: true,
      });
      return { kind: "scan", retryFailed: Boolean(values["retry-failed"]) };
    }
```

- [ ] **Step 4: Implement `main.ts`**

In `src/cli/main.ts`, change `runScanCommand`'s signature to accept the flag, and scope discovery
when set:

```ts
export async function runScanCommand(
  repo: Repository,
  log: Logger,
  retryFailed: boolean,
): Promise<void> {
  const profile = repo.getLatestProfile();
  if (!profile) {
    log(style.warn("No profile yet. Run `job-hunter profile <resume-file>` first."));
    process.exitCode = 1;
    return;
  }

  let trackedCompanies = repo.listTrackedCompanies();
  let sources: DiscoverDeps["sources"] | undefined;
  if (retryFailed) {
    const needsAttention = repo.listNeedsAttention();
    if (needsAttention.length === 0) {
      log(style.dim("Nothing needs attention — every company scanned cleanly recently."));
      return;
    }
    trackedCompanies = needsAttention.map((c) => ({ careersUrl: c.careersUrl, name: c.company }));
    sources = []; // scope the crawl to just these companies, not the full directory
  }

  const dictionary = repo.getSkillDictionary();
  const scorer = new HeuristicScorer(dictionary.length > 0 ? dictionary : undefined);

  const fetcher = new HttpFetcher();
  const feed = resolvePostingFeed(repo, fetcher);

  const result = await runScan(
    {
      repo,
      profile,
      scorer,
      ...(feed ? { feed } : {}),
      onProgress: (event) => log(style.dim(formatProgress(event))),
      discoverDeps: {
        fetcher,
        renderer: new PlaywrightRenderer(),
        sharedViewReader: new PlaywrightSharedViewReader(),
        shareUrl: resolveShareUrl(),
        trackedCompanies,
        settings: settingsWithEnvKey(repo),
        ...(sources ? { sources } : {}),
      },
    },
    () => {},
  );
  for (const warning of result.warnings) {
    log(style.warn(`  ! [${warning.source}] ${warning.message}`));
  }
}
```

`main.ts` does not currently import `DiscoverDeps` (confirmed against its current import block, which
starts with `import { resolve } from "node:path";`) — add
`import type { DiscoverDeps } from "@app/discovery/discover";` to that block, grouped with the other
`@app/discovery/*` imports (alongside `resolvePostingFeed`, `resolveShareUrl`,
`PlaywrightSharedViewReader`).

Update the dispatch site (around line 228-230):

```ts
      case "scan":
        await runScanCommand(repo, log, command.retryFailed);
        break;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/cli/parse.test.ts src/cli/main.test.ts`
Expected: PASS — all tests in both files.

- [ ] **Step 6: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/parse.ts src/cli/main.ts src/cli/parse.test.ts src/cli/main.test.ts
git commit -m "feat(cli): add scan --retry-failed to rescan only companies needing attention"
```

---

### Task 7: Dashboard API — `GET /api/companies/needs-attention` + `POST /api/scan/retry-failed`

**Files:**
- Modify: `src/server/types.ts` (`ServerDeps` gains `retryFailedScan: ScanRunner`)
- Modify: `src/server/scan-runner.ts` (export a second runner factory, scoped)
- Modify: `src/server/app.ts` (two new routes)
- Modify: `src/server/serve.ts` (wire the new runner into `ServerDeps`)
- Test: `src/server/app.test.ts`

**Interfaces:**
- Consumes: `Repository.listNeedsAttention` (Task 3); `ScanRunner` type (already in
  `src/server/types.ts`); `ScanJobManager.start` (already accepts any `ScanRunner`, no changes
  needed there).
- Produces: `GET /api/companies/needs-attention` → `repo.listNeedsAttention()`.
  `POST /api/scan/retry-failed` → `jobs.start(deps.retryFailedScan)`, same 202/409 single-flight
  contract as `POST /api/scan`.

- [ ] **Step 1: Write the failing tests**

Add to `src/server/app.test.ts`, inside (or near) the existing `describe("companies", ...)` and
`describe("scan jobs", ...)` blocks:

```ts
describe("GET /api/companies/needs-attention", () => {
  it("returns the needs-attention list", async () => {
    repo.recordScanFailures(1, [
      { careersUrl: "https://boom.com/careers", company: "Boom", message: "timeout" },
    ]);
    const res = await makeApp().request("/api/companies/needs-attention");
    expect(await json(res)).toEqual([
      {
        careersUrl: "https://boom.com/careers",
        company: "Boom",
        message: "timeout",
        consecutiveFailures: 1,
      },
    ]);
  });
});

describe("POST /api/scan/retry-failed", () => {
  it("starts the retry-failed scan job (202) and reports 409 if already running", async () => {
    const jobs = new ScanJobManager();
    const app = makeApp({
      jobs,
      retryFailedScan: async () => ({ count: 0, warnings: [] }),
    });
    const first = await app.request("/api/scan/retry-failed", { method: "POST" });
    expect(first.status).toBe(202);

    // Force "running" by starting a long job directly, then confirm the second call 409s.
    jobs.start(() => new Promise(() => {})); // never resolves within the test
    const second = await app.request("/api/scan/retry-failed", { method: "POST" });
    expect(second.status).toBe(409);
  });
});
```

Also add `retryFailedScan: async () => ({ count: 0, warnings: [] }),` to the default `deps` object
inside `makeApp()` (around line 46-59), matching the existing `runScan` default, so every other test
in the file keeps passing without needing to know about the new dependency.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/server/app.test.ts -t "needs-attention"`
Run: `npx vitest run src/server/app.test.ts -t "retry-failed"`
Expected: FAIL — the routes don't exist yet (404), and `ServerDeps` doesn't have `retryFailedScan` so
`makeApp`'s override is currently just an extra unused property (TypeScript will actually error on
this before the test runs, since `ServerDeps` is a closed type — that's expected until Step 3).

- [ ] **Step 3: Add `retryFailedScan` to `ServerDeps`**

In `src/server/types.ts`, add to `ServerDeps` (after `runScan: ScanRunner;`):

```ts
  /** The scan to run for `POST /api/scan/retry-failed` — scoped to the needs-attention list. */
  retryFailedScan: ScanRunner;
```

- [ ] **Step 4: Add the two routes to `app.ts`**

In `src/server/app.ts`, near the existing `/api/companies/manual-review` route (around line 133-137):

```ts
  app.get("/api/companies/needs-attention", (c) => c.json(repo.listNeedsAttention()));
```

Near the existing `/api/scan` routes (around line 274-284):

```ts
  // Rescan only the companies currently in the "needs attention" list (>=5 consecutive failures).
  // Same single-flight 202/409 contract as POST /api/scan.
  app.post("/api/scan/retry-failed", (c) => {
    const started = jobs.start(retryFailedScan);
    return c.json(jobs.getStatus(), started ? 202 : 409);
  });
```

`createApp` destructures `deps` at its top (`src/server/app.ts:75-84`:
`const { repo, jobs, runScan, scoreJobs, createScoreRun, previewScore, buildProfileFromText,
getUpdateStatus } = deps;`) — add `retryFailedScan` to that destructuring list so the new route can
reference the bare name `retryFailedScan`, consistent with how `runScan` is referenced elsewhere in
the file (e.g. the existing `POST /api/scan` handler at line 277: `jobs.start(runScan)`).

- [ ] **Step 5: Wire the real runner in `scan-runner.ts` and `serve.ts`**

In `src/server/scan-runner.ts`, add a second exported factory reusing `createScanRunner`'s shape but
scoped to the needs-attention list:

```ts
/**
 * Scoped scan runner for `POST /api/scan/retry-failed`: crawls only the companies currently in the
 * "needs attention" list (repeated per-company failures), not the full directory. Mirrors
 * `createScanRunner` but fixes `trackedCompanies`/`sources` to the scoped list.
 */
export function createRetryFailedScanRunner(repo: Repository): ScanRunner {
  return async (onProgress) => {
    const profile = repo.getLatestProfile();
    if (!profile) throw new Error("No profile yet. Upload a resume first.");

    const needsAttention = repo.listNeedsAttention();
    if (needsAttention.length === 0) {
      return { count: 0, warnings: [] };
    }

    const dictionary = repo.getSkillDictionary();
    const scorer = new HeuristicScorer(dictionary.length > 0 ? dictionary : undefined);
    const fetcher = new HttpFetcher();
    const feed = resolvePostingFeed(repo, fetcher);

    const result = await runScan(
      {
        repo,
        profile,
        scorer,
        ...(feed ? { feed } : {}),
        onProgress: (event) => {
          onProgress(event);
          console.log(`${style.dim("[scan]")} ${formatProgress(event)}`);
        },
        discoverDeps: {
          fetcher,
          renderer: new PlaywrightRenderer(),
          sharedViewReader: new PlaywrightSharedViewReader(),
          shareUrl: resolveShareUrl(),
          trackedCompanies: needsAttention.map((c) => ({
            careersUrl: c.careersUrl,
            name: c.company,
          })),
          sources: [],
          settings: settingsWithEnvKey(repo),
        },
      },
      (message) => console.log(`${style.dim("[scan]")} ${message}`),
    );

    return { count: result.count, warnings: result.warnings };
  };
}
```

In `src/server/serve.ts`, wire it in alongside the existing `const runScan = createScanRunner(repo);`
(around line 93):

```ts
  const runScan = createScanRunner(repo);
  const retryFailedScan = createRetryFailedScanRunner(repo);
```

And import it: `import { createScanRunner, createRetryFailedScanRunner } from "./scan-runner";` —
then add `retryFailedScan,` to the `ServerDeps` object literal passed to `createApp` (around line
99).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/server/app.test.ts`
Expected: PASS — all tests in the file.

- [ ] **Step 7: Full suite + typecheck + lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server/types.ts src/server/scan-runner.ts src/server/app.ts src/server/serve.ts src/server/app.test.ts
git commit -m "feat(server): add needs-attention list and scoped retry-failed scan endpoint"
```

---

### Task 8: Web API client + hooks

**Files:**
- Modify: `web/src/api.ts` (new schema + two client functions)
- Modify: `web/src/hooks.ts` (new query + mutation hooks — `hooks.ts` currently has no dedicated test
  for its plain query/mutation hooks like `useCompanies`/`useManualReviewCompanies`/`useStartScan`;
  `web/src/hooks.test.ts` only covers `useMatchAction`'s optimistic-update logic. `useNeedsAttention`
  and `useRetryFailedScan` are equally thin wrappers, so — matching the project's existing testing
  depth for this kind of hook — they get no dedicated hook-level test; they're exercised through the
  Task 9 component test instead.)
- Test: `web/src/api.test.ts` only (the schema-parsing boundary is the layer this project tests
  directly for simple request/response shapes — see its existing `describe("api response
  validation", ...)` block).

**Interfaces:**
- Consumes: `GET /api/companies/needs-attention`, `POST /api/scan/retry-failed` (Task 7).
- Produces: `api.getNeedsAttention(): Promise<NeedsAttentionEntry[]>`,
  `api.retryFailedScan(): Promise<ScanJobStatus>`; `useNeedsAttention()`, `useRetryFailedScan()`.

- [ ] **Step 1: Write the failing tests**

Add to `web/src/api.test.ts`, inside the existing `describe("api response validation", ...)` block
(the file has one `mockFetchOnce(body, init)` helper already defined at the top — reuse it):

```ts
  it("parses a needs-attention list", async () => {
    const entries = [
      {
        careersUrl: "https://boom.com/careers",
        company: "Boom",
        message: "render crashed",
        consecutiveFailures: 5,
      },
    ];
    mockFetchOnce(entries);

    await expect(api.getNeedsAttention()).resolves.toEqual(entries);
  });

  it("retryFailedScan treats both 202 and 409 as a valid scan-status body", async () => {
    const status = {
      state: "running",
      message: null,
      current: null,
      total: null,
      count: null,
      warnings: [],
      error: null,
      startedAt: "2026-06-30T00:00:00.000Z",
      finishedAt: null,
      recent: [],
    };
    mockFetchOnce(status, { ok: false, status: 409 });

    await expect(api.retryFailedScan()).resolves.toEqual(status);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:web -- src/api.test.ts`
Expected: FAIL — `api.getNeedsAttention` and `api.retryFailedScan` don't exist yet.

- [ ] **Step 3: Implement `api.ts`**

Add a new schema (near `CompanyRefSchema`, since it's a superset of that shape):

```ts
const NeedsAttentionEntrySchema = z.object({
  careersUrl: z.string(),
  company: z.string(),
  message: z.string(),
  consecutiveFailures: z.number(),
});
export type NeedsAttentionEntry = z.infer<typeof NeedsAttentionEntrySchema>;
```

Also update the inline warning schema inside `ScanJobStatusSchema` (line 114) to include the new
optional field, so a per-company warning surfaced via scan-status polling round-trips correctly:

```ts
  warnings: z.array(
    z.object({ source: z.string(), message: z.string(), careersUrl: z.string().optional() }),
  ),
```

Add to the `api` object (near `getManualReviewCompanies` and `startScan` respectively):

```ts
  getNeedsAttention: () =>
    request("/api/companies/needs-attention", z.array(NeedsAttentionEntrySchema)),
  // Same 202/409-both-ok semantics as startScan — either way the body is the current job status.
  retryFailedScan: async (): Promise<ScanJobStatus> => {
    const res = await fetch("/api/scan/retry-failed", { method: "POST" });
    if (res.status === 202 || res.status === 409 || res.ok) {
      return ScanJobStatusSchema.parse(await res.json());
    }
    throw new Error(`${res.status} ${res.statusText}`);
  },
```

- [ ] **Step 4: Implement `hooks.ts`**

Add near `useManualReviewCompanies` and `useStartScan` respectively:

```ts
export function useNeedsAttention() {
  return useQuery({ queryKey: ["companies", "needs-attention"], queryFn: api.getNeedsAttention });
}

export function useRetryFailedScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.retryFailedScan,
    onSuccess: (status) => qc.setQueryData(["scan-status"], status),
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:web`
Expected: PASS — full web suite.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck:web`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/api.ts web/src/hooks.ts web/src/api.test.ts
git commit -m "feat(web): add needs-attention query and retry-failed-scan mutation"
```

---

### Task 9: "Needs attention" dashboard panel

**Files:**
- Modify: `web/src/views/Companies.tsx` (new panel, mirroring the existing manual-review panel)
- Create: `web/src/views/Companies.test.tsx` — **`Companies.tsx` has no existing test file**
  (confirmed: only `Home.test.tsx` and `Matches.test.tsx` exist under `web/src/views/`). This task
  creates one from scratch, following `Home.test.tsx`'s established pattern for a full-component
  render test: a URL-routed `fetch` mock (`mockFetch(bodies)` switching on `url.includes(...)`),
  wrapped in a fresh `QueryClient`/`QueryClientProvider`, driven with `render`/`screen`/`userEvent`
  from `@testing-library/react` + `@testing-library/user-event`.

**Interfaces:**
- Consumes: `useNeedsAttention()`, `useRetryFailedScan()` (Task 8).
- Produces: a new "Needs attention" `Card` panel in the `Companies` view, rendered only when
  `needsAttention.data.length > 0`, listing company/message/consecutive-failure-count with a
  "Rescan" button.

- [ ] **Step 1: Write the failing test file**

Create `web/src/views/Companies.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Companies } from "./Companies";

type Bodies = {
  companies?: { careersUrl: string; name?: string }[];
  manualReview?: { careersUrl: string; name?: string }[];
  needsAttention?: {
    careersUrl: string;
    company: string;
    message: string;
    consecutiveFailures: number;
  }[];
};

function mockFetch(bodies: Bodies) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const body = (() => {
        if (url.includes("/api/companies/needs-attention")) return bodies.needsAttention ?? [];
        if (url.includes("/api/companies/manual-review")) return bodies.manualReview ?? [];
        if (url.includes("/api/scan/retry-failed") && init?.method === "POST") {
          return {
            state: "running",
            message: null,
            current: null,
            total: null,
            count: null,
            warnings: [],
            error: null,
            startedAt: "2026-07-01T00:00:00.000Z",
            finishedAt: null,
            recent: [],
          };
        }
        if (url.includes("/api/companies")) return bodies.companies ?? [];
        return [];
      })();
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(body),
      });
    }),
  );
}

function renderCompanies() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return render(<Companies />, { wrapper });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Companies needs-attention panel", () => {
  it("does not render the panel when the needs-attention list is empty", async () => {
    mockFetch({ needsAttention: [] });
    renderCompanies();
    await waitFor(() => expect(screen.queryByText(/Needs attention/i)).not.toBeInTheDocument());
  });

  it("renders each company with its message and failure count", async () => {
    mockFetch({
      needsAttention: [
        {
          careersUrl: "https://boom.com/careers",
          company: "Boom",
          message: "render crashed",
          consecutiveFailures: 5,
        },
      ],
    });
    renderCompanies();

    await waitFor(() => expect(screen.getByText(/Needs attention \(1\)/i)).toBeInTheDocument());
    expect(screen.getByText("Boom")).toBeInTheDocument();
    expect(screen.getByText(/render crashed/)).toBeInTheDocument();
    expect(screen.getByText(/5 scans/)).toBeInTheDocument();
  });

  it("triggers a rescan when the Rescan button is clicked", async () => {
    mockFetch({
      needsAttention: [
        {
          careersUrl: "https://boom.com/careers",
          company: "Boom",
          message: "render crashed",
          consecutiveFailures: 5,
        },
      ],
    });
    renderCompanies();

    const button = await screen.findByRole("button", { name: "Rescan" });
    await userEvent.click(button);

    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(
          (call) => String(call[0]).includes("/api/scan/retry-failed") && call[1]?.method === "POST",
        ),
      ).toBe(true),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:web -- src/views/Companies.test.tsx`
Expected: FAIL — `useNeedsAttention`/`useRetryFailedScan` exist (from Task 8) but `Companies.tsx`
doesn't render the panel yet, so "Needs attention" never appears and there's no "Rescan" button to
click.

- [ ] **Step 3: Implement the panel**

In `web/src/views/Companies.tsx`, import the new hooks:

```ts
import { useAddCompany, useCompanies, useManualReviewCompanies, useNeedsAttention, useRemoveCompany, useRetryFailedScan } from "../hooks";
```

Inside the `Companies()` component, add:

```ts
  const needsAttention = useNeedsAttention();
  const retryFailedScan = useRetryFailedScan();
```

And, after the existing "Review manually" panel (after its closing `) : null}` around line 140), add:

```tsx
      {needsAttention.data && needsAttention.data.length > 0 ? (
        <Card>
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold text-fg">
              Needs attention ({needsAttention.data.length})
            </h2>
            <Button
              onClick={() => retryFailedScan.mutate()}
              disabled={retryFailedScan.isPending}
            >
              Rescan
            </Button>
          </div>
          <p className="mt-1 text-xs text-faint">
            These companies have failed to fetch on 5+ consecutive scans — they're still crawled
            normally, but no longer auto-retried within a run. Rescan to try them again now.
          </p>
          <ul className="mt-3 space-y-1">
            {needsAttention.data.map((c) => (
              <li key={c.careersUrl} className="text-sm">
                <span className="font-medium text-fg">{c.company}</span>{" "}
                <span className="text-faint">
                  — {c.message} ({c.consecutiveFailures} scans)
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
```

`Button` (`web/src/components/ui.tsx:11-16`) spreads `ButtonHTMLAttributes<HTMLButtonElement>`, so
`onClick`/`disabled` are valid props exactly as used above — same as the existing `<Button
type="submit" disabled={...}>` usage in the "Track a company" form a few lines above in this file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:web -- src/views/Companies.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full web suite + typecheck + build**

Run: `npm run test:web && npm run typecheck:web && npm run build:web`
Expected: PASS, build succeeds with no errors.

- [ ] **Step 6: Manually verify in the browser**

Run: `npm run dev:web` (with a `job-hunter serve` instance running so `/api` proxies successfully).
Seed a company into `failed_leads` at threshold via the CLI or a direct DB write, navigate to the
Companies tab, confirm the "Needs attention" panel renders with the right data and the "Rescan"
button triggers a scan (watch the Home tab's scan status indicator start "running").

- [ ] **Step 7: Commit**

```bash
git add web/src/views/Companies.tsx web/src/views/Companies.test.tsx
git commit -m "feat(web): show a needs-attention panel with a rescan action"
```

---

### Task 10: Full-suite verification + coverage check

**Files:** none (verification-only task)

**Interfaces:** none — this task confirms the whole feature's cross-cutting invariants hold.

- [ ] **Step 1: Run the complete gate, matching CI's order**

```bash
npm run lint
npm run typecheck
npm run typecheck:web
npm run test:coverage
npm run test:web
npm run build:web
```

Expected: every command exits 0. `test:coverage` must stay at or above statements 93 / branches 85 /
functions 90 / lines 93 — if the new `failed_leads`/retry-pass code brought any metric under the
floor, add tests to cover the gap (do not lower the threshold in `vitest.config.ts`).

- [ ] **Step 2: Confirm the hosted Postgres worker is untouched**

```bash
npx vitest run src/backend/scanner/run-once.test.ts
git diff main...HEAD -- src/backend/scanner/ src/discovery/scan-store.ts
```

Expected: the test file passes, and the diff against `main` for these paths is empty (or, if Task 5's
`SourcingOutcome.scanId` change required a compatibility fix in `run-once.test.ts`'s assertions per
Task 5 Step 5's note, confirm that fix is narrowly scoped to accepting the new field, not a behavior
change to the worker itself).

- [ ] **Step 3: Manual end-to-end smoke (optional but recommended)**

If a resume profile and a real network path are available, run `job-hunter scan` once against a
small `trackedCompanies` set including a deliberately-broken URL (e.g. a 404 careers page) to observe
a real warning with `careersUrl` set, then run `job-hunter scan` four more times to push it to the
5-failure threshold, then confirm `job-hunter scan --retry-failed` picks it up and
`GET /api/companies/needs-attention` reflects it via the dashboard.

- [ ] **Step 4: Final commit (if Step 1 required any fixes)**

```bash
git add -A
git commit -m "test: close coverage gaps from the retry-failed-companies feature"
```

(Skip this step entirely if Step 1 passed clean on the first try — don't create an empty commit.)

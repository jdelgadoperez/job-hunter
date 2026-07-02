# Incremental Scan with Configurable Freshness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `"incremental"` scan scope that skips directory companies scanned within a configurable freshness window (default 24h), with a dashboard "Rescan all" override and a CLI `--all` / `--freshness-hours` surface — without ever expiring the postings of skipped companies.

**Architecture:** Extend `ScanScope` with `"incremental"`. Discovery gains an optional `skipCareersUrls` set that `collectLeads` applies to *directory* leads only (never tracked). `runSourcing` builds that set from a new `repo.listFreshCompanyUrls(freshnessHours)` when scope is incremental, and — crucially — gates `computeRemoved` and the liveness/expiry pass to `scope === "full"` only, so incremental (like retry) never expires uncrawled companies. A new `scanFreshnessHours` setting drives the window. Server exposes scope via the `POST /api/scan` body; the dashboard adds a "Rescan all" checkbox; the CLI adds `--all` / `--freshness-hours`.

**Tech Stack:** TypeScript-strict ESM, `better-sqlite3`, Hono, Vite + React 19 + TanStack Query + zod, vitest (colocated, offline).

## Global Constraints

- TypeScript-strict, ESM. No type assertions; NEVER the `!` non-null assertion.
- No new dependencies.
- **Incremental scans MUST record `kind = 'incremental'` and MUST skip liveness/expiry** — a skipped company's live postings must survive. `expireStalePostings` already counts only `kind = 'full'` scans (`repository.ts:668`); `runSourcing` already gates the liveness pass on `scope === "full"` (`commands.ts:198-202`). Incremental gets both protections by being `!== "full"`.
- **Tracked companies are always crawled**, regardless of freshness.
- Default window: `SCAN_FRESHNESS_HOURS_DEFAULT = 24`. A stored `0` disables skipping (behaves full).
- Directory diff (`computeRemoved`) stays `scope === "full"` only — a subset crawl can't compute "removed".
- Biome: 2-space indent, 100-col, double quotes. Run `./node_modules/.bin/biome check .` before commit.
- Coverage gate: statements 93 / branches 85 / functions 90 / lines 93. Web tests: `npm run test:web`.
- API contract: any `web/src/api.ts` schema change must keep the `api.test.ts` drift test green.
- Conventional Commits. NO Claude co-authored footer.

## File Structure

- `src/discovery/scan-store.ts` — `ScanScope` union gains `"incremental"`.
- `src/discovery/discover.ts` — `DiscoverDeps.skipCareersUrls?: Set<string>`; `collectLeads` applies it to source leads only.
- `src/storage/repository.ts` — `listFreshCompanyUrls(freshnessHours)`; wire skip-set into `runSourcing` scope handling (in `commands.ts`).
- `src/cli/commands.ts` — `runSourcing`/`runScan` pass the skip-set when scope is incremental.
- `src/matching/settings-keys.ts` + `resolve-settings.ts` — `SCAN_FRESHNESS_SETTING`, `resolveScanFreshnessHours`.
- `src/server/scan-runner.ts` — `createScanRunner(repo)` becomes scope-aware (curried by scope).
- `src/server/types.ts` — `ScanRunOptions` / runner factory shape.
- `src/server/app.ts` — `POST /api/scan` parses `scope` from the body.
- `src/server/serve.ts` — build runners per scope; scheduled refresh uses incremental.
- `web/src/api.ts` — `startScan(scope)`; scope in the request body.
- `web/src/views/Home.tsx` — "Rescan all" checkbox.
- `web/src/views/Settings.tsx` + settings API — freshness-hours input.

---

### Task 1: Add `"incremental"` to `ScanScope`

**Files:**
- Modify: `src/discovery/scan-store.ts:5`
- Test: `src/discovery/scan-store.test.ts` if it exists; otherwise this is a type-only change verified by `typecheck` and downstream tasks.

**Interfaces:**
- Produces: `ScanScope = "full" | "retry" | "incremental"`.

- [ ] **Step 1: Widen the union**

In `src/discovery/scan-store.ts`, change line 5:

```typescript
/** Whether a scan crawled the whole directory (`"full"`), a scoped retry subset (`"retry"`), or an
 *  incremental pass that skips recently-scanned companies (`"incremental"`). */
export type ScanScope = "full" | "retry" | "incremental";
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. `startScan(kind: ScanScope = "full")` and the `scope === "full"`/`scope === "retry"` comparisons in `commands.ts` still typecheck (incremental just isn't handled yet — added in Task 3).

- [ ] **Step 3: Commit**

```bash
git add src/discovery/scan-store.ts
git commit -m "feat(scan): add incremental scan scope"
```

---

### Task 2: `listFreshCompanyUrls` on the repository

**Files:**
- Modify: `src/storage/repository.ts` (add a public method near the other company reads, e.g. after `listTrackedCompanies`)
- Test: `src/storage/repository.test.ts`

**Interfaces:**
- Produces: `listFreshCompanyUrls(freshnessHours: number): string[]` — normalized-or-raw `careers_url` strings for companies whose `last_seen_at` is within the window. Returns `[]` when `freshnessHours <= 0` (skip nothing). Callers build a `Set` from it.

- [ ] **Step 1: Write the failing test**

Add to `src/storage/repository.test.ts` (uses the in-memory `newRepo()` helper at line 10). To control `last_seen_at`, insert companies via a raw handle or the repo's directory-record path with a back-dated timestamp. Prefer inserting through the repo's public scan path and then updating `last_seen_at` directly with a second `new Repository` is not possible on `:memory:`; instead use a file DB like the migrate tests, OR add companies through `recordDirectory` and update the timestamp via a small raw statement on the same connection. Use the file-DB idiom already in the test file (`mkdtempSync` + `Database`, see `repository.test.ts:577`):

```typescript
describe("listFreshCompanyUrls", () => {
  it("returns companies scanned within the window and excludes stale ones; empty when hours<=0", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobhunter-fresh-"));
    const dbPath = join(dir, "fresh.db");
    try {
      const repo = new Repository(dbPath);
      // Seed two companies via a scan, then back-date one to be stale.
      const raw = new Database(dbPath);
      // A company scanned "now" (fresh) and one scanned 48h ago (stale).
      raw
        .prepare(
          "INSERT INTO companies (careers_url, name, first_seen_scan, last_seen_scan, last_seen_at) " +
            "VALUES (?, ?, 1, 1, datetime('now'))",
        )
        .run("https://fresh.co/careers", "Fresh Co");
      raw
        .prepare(
          "INSERT INTO companies (careers_url, name, first_seen_scan, last_seen_scan, last_seen_at) " +
            "VALUES (?, ?, 1, 1, datetime('now', '-48 hours'))",
        )
        .run("https://stale.co/careers", "Stale Co");
      raw.close();

      // Re-open so the repo reads the seeded rows.
      const repo2 = new Repository(dbPath);
      const fresh = repo2.listFreshCompanyUrls(24);
      expect(fresh).toContain("https://fresh.co/careers");
      expect(fresh).not.toContain("https://stale.co/careers");

      // hours<=0 disables skipping entirely.
      expect(repo2.listFreshCompanyUrls(0)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/storage/repository.test.ts -t "listFreshCompanyUrls"`
Expected: FAIL — `repo2.listFreshCompanyUrls is not a function`.

- [ ] **Step 3: Implement the method**

In `src/storage/repository.ts`, add (near `listTrackedCompanies`):

```typescript
  /**
   * Careers URLs of companies scanned within the last `freshnessHours`. An incremental scan uses
   * this to skip re-crawling companies that are still fresh. Returns `[]` when `freshnessHours <= 0`
   * so a zero/negative window disables skipping entirely (an incremental scan then behaves like full).
   */
  listFreshCompanyUrls(freshnessHours: number): string[] {
    if (freshnessHours <= 0) return [];
    const rows = this.db
      .prepare(
        `SELECT careers_url FROM companies
         WHERE last_seen_at IS NOT NULL
           AND last_seen_at >= datetime('now', ?)`,
      )
      .all(`-${freshnessHours} hours`) as { careers_url: string }[];
    return rows.map((r) => r.careers_url);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/storage/repository.test.ts -t "listFreshCompanyUrls"`
Expected: PASS.

- [ ] **Step 5: Run the storage suite + lint**

Run: `npx vitest run src/storage/ && ./node_modules/.bin/biome check src/storage/repository.ts`
Expected: pass, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/storage/repository.ts src/storage/repository.test.ts
git commit -m "feat(storage): listFreshCompanyUrls for incremental scan skipping"
```

---

### Task 3: `skipCareersUrls` filter in discovery

**Files:**
- Modify: `src/discovery/discover.ts:17-33` (`DiscoverDeps`), `:59-99` (`collectLeads`)
- Test: `src/discovery/discover.test.ts`

**Interfaces:**
- Consumes: nothing new from earlier tasks.
- Produces: `DiscoverDeps.skipCareersUrls?: Set<string>` — when present, `collectLeads` drops **source** (directory) leads whose normalized careers URL is in the set, but keeps every tracked lead.

- [ ] **Step 1: Write the failing test**

Inspect `src/discovery/discover.test.ts` for its fixture style (injected `sources`, `trackedCompanies`, a stub fetcher/renderer). Add a test that passes a directory source with two companies, marks one as fresh via `skipCareersUrls`, and asserts only the non-fresh directory company plus all tracked companies are crawled. Use the file's existing helpers; sketch:

```typescript
it("skips directory leads in skipCareersUrls but keeps tracked companies", async () => {
  // A directory source that yields two companies; one is 'fresh' and must be skipped.
  const sources = [stubSource([
    { company: "Fresh Co", careersUrl: "https://fresh.co/careers", categories: [] },
    { company: "Stale Co", careersUrl: "https://stale.co/careers", categories: [] },
  ])];
  const result = await discover({
    ...baseDeps, // fetcher/renderer/etc from the file's existing helper
    sources,
    trackedCompanies: [{ careersUrl: "https://tracked.co/careers", name: "Tracked Co" }],
    skipCareersUrls: new Set(["https://fresh.co/careers"]),
  });
  const crawledUrls = new Set(result.companies?.map((c) => c.careersUrl) ?? []);
  expect(crawledUrls.has("https://stale.co/careers")).toBe(true);
  expect(crawledUrls.has("https://tracked.co/careers")).toBe(true);
  expect(crawledUrls.has("https://fresh.co/careers")).toBe(false);
});
```

NOTE: match the file's real helper names (`stubSource`, `baseDeps`, etc. may differ — read the file and reuse whatever it already defines). The skip set should be compared against the **normalized** careers URL, matching how dedup keys are built (`normalizeCareersUrl`, imported in discover.ts).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/discovery/discover.test.ts -t "skips directory leads"`
Expected: FAIL — the fresh company is still crawled (no skip logic yet), so `crawledUrls.has("https://fresh.co/careers")` is `true`.

- [ ] **Step 3: Add `skipCareersUrls` to `DiscoverDeps`**

In `src/discovery/discover.ts`, add to the `DiscoverDeps` type (after `sources?`, around line 33):

```typescript
  /** Normalized careers URLs to skip among DIRECTORY leads (an incremental scan's fresh companies).
   *  Tracked companies are never skipped. */
  skipCareersUrls?: Set<string>;
```

- [ ] **Step 4: Apply the skip in `collectLeads`**

In `collectLeads`, filter source leads (NOT tracked) before the merge. Change the block that builds `trackedLeads` / merges (lines 87-97):

```typescript
  const trackedLeads: CompanyLead[] = (deps.trackedCompanies ?? []).map((tracked) => ({
    company: tracked.name ?? hostnameOf(tracked.careersUrl),
    careersUrl: tracked.careersUrl,
    categories: [],
  }));

  // An incremental scan skips directory companies crawled recently. Applied to SOURCE leads only —
  // tracked companies are always crawled (a user who just added one expects it scanned now).
  const skip = deps.skipCareersUrls;
  const keptSourceLeads = skip
    ? sourceLeads.filter((lead) => !skip.has(normalizeCareersUrl(lead.careersUrl)))
    : sourceLeads;

  const byUrl = new Map<string, CompanyLead>();
  for (const lead of [...keptSourceLeads, ...trackedLeads]) {
    const key = normalizeCareersUrl(lead.careersUrl);
    if (!byUrl.has(key)) byUrl.set(key, lead);
  }

  return { leads: [...byUrl.values()], warnings };
```

(`normalizeCareersUrl` is already imported in discover.ts — confirm at the top; it's used for the dedup key on line 95.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/discovery/discover.test.ts -t "skips directory leads"`
Expected: PASS — fresh directory company skipped, stale + tracked crawled.

- [ ] **Step 6: Run the discovery suite + lint**

Run: `npx vitest run src/discovery/ && ./node_modules/.bin/biome check src/discovery/discover.ts`
Expected: pass. Existing discover tests (no `skipCareersUrls`) unaffected.

- [ ] **Step 7: Commit**

```bash
git add src/discovery/discover.ts src/discovery/discover.test.ts
git commit -m "feat(discovery): skipCareersUrls filter for incremental directory leads"
```

---

### Task 4: Wire incremental scope through `runSourcing`

**Files:**
- Modify: `src/cli/commands.ts` — `runSourcing` (`:148-210`) builds the skip-set for incremental; `SourcingDeps`/`ScanDeps` gain a `freshnessHours` input.
- Test: `src/cli/commands.test.ts`

**Interfaces:**
- Consumes: `repo.listFreshCompanyUrls` (Task 2), `DiscoverDeps.skipCareersUrls` (Task 3), `ScanScope` incremental (Task 1).
- Produces: an incremental `runSourcing` that records `kind = 'incremental'`, skips fresh directory companies, and (like retry) does NOT compute removed or run liveness/expiry.

- [ ] **Step 1: Write the failing test**

In `src/cli/commands.test.ts`, add a test that runs `runSourcing` with `scope: "incremental"`, a fake repo whose `listFreshCompanyUrls` returns one URL, and asserts (a) that URL was NOT crawled, (b) `startScan` was called with `"incremental"`, (c) `expireStalePostings` was NOT called (skipped companies keep their postings). Use the file's existing fake-repo/injected-deps style (read how `runSourcing`/`runScan` are tested there — there are existing scope tests for `"retry"` to mirror). Sketch:

```typescript
it("incremental scope skips fresh companies, records kind=incremental, and does not expire", async () => {
  const startScanCalls: string[] = [];
  const expireCalls: number[] = [];
  const repo = makeFakeSourcingRepo({ // reuse the file's existing fake builder
    freshUrls: ["https://fresh.co/careers"],
    onStartScan: (kind) => startScanCalls.push(kind),
    onExpire: (id) => expireCalls.push(id),
  });
  const crawled = trackCrawledUrls(); // capture which leads discovery received
  await runSourcing({
    repo,
    onProgress: () => {},
    scope: "incremental",
    freshnessHours: 24,
    discoverDeps: makeDiscoverDeps({ /* directory source with fresh.co + stale.co */ }),
  });
  expect(startScanCalls).toEqual(["incremental"]);
  expect(crawled.urls).not.toContain("https://fresh.co/careers");
  expect(expireCalls).toEqual([]); // no expiry under incremental
});
```

NOTE: match the actual fake/helper names in `commands.test.ts`. If the existing tests assert scope behavior differently (e.g. by checking `computeRemoved` via the recorded diff), follow that assertion style instead of inventing `makeFakeSourcingRepo`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/cli/commands.test.ts -t "incremental scope skips fresh"`
Expected: FAIL — `runSourcing` doesn't build a skip-set or pass `freshnessHours`, so fresh.co is still crawled and/or `startScan` gets a default.

- [ ] **Step 3: Add `freshnessHours` to the sourcing deps and build the skip-set**

In `src/cli/commands.ts`, add `freshnessHours?: number` to the `SourcingDeps` type (near the `scope?: ScanScope` field around line 87) and to `ScanDeps` (around line 114). In `runSourcing` (after `const scope = deps.scope ?? "full";`, line 150), build the skip-set for incremental and thread it into `discoverDeps`:

```typescript
  const scope = deps.scope ?? "full";

  // For an incremental scan, skip directory companies crawled within the freshness window. Built
  // here so the same skip-set flows to whichever sourcing path runs (feed+tracked or full crawl).
  const skipCareersUrls =
    scope === "incremental"
      ? new Set(
          (await repo.listFreshCompanyUrls(deps.freshnessHours ?? 0)).map((url) =>
            normalizeCareersUrl(url),
          ),
        )
      : undefined;
```

Then pass `skipCareersUrls` into the `discoverDeps` used by both `sourceFromFeedAndTracked` and `sourceFromFullCrawl`. The simplest correct wiring: merge it into `deps.discoverDeps` once:

```typescript
  const discoverDeps = skipCareersUrls
    ? { ...deps.discoverDeps, skipCareersUrls }
    : deps.discoverDeps;
```

…and replace the two `deps.discoverDeps` uses inside the `feed ? sourceFromFeedAndTracked(...) : sourceFromFullCrawl(...)` call with `discoverDeps`. (Confirm `normalizeCareersUrl` is imported in commands.ts — it's used elsewhere in the file for companyId; if not, add `import { normalizeCareersUrl } from "@app/domain/normalize";`.)

- [ ] **Step 4: Gate `computeRemoved` and liveness to include incremental as non-full**

The existing gates already use `scope === "full"`, so incremental is automatically excluded — VERIFY they read `scope === "full"` (not `scope !== "retry"`):
- `recordDirectory(..., { computeRemoved: scope === "full" })` (line 172) — correct as-is.
- liveness/expiry: `scope === "full" ? (...) : 0` (lines 198-202) — correct as-is.

No change needed if both already compare to `"full"`. If either compares to `"retry"`, change it to `"full"`. (Read the current lines to confirm; the spec relies on this.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/cli/commands.test.ts -t "incremental scope skips fresh"`
Expected: PASS — `startScan("incremental")`, fresh.co skipped, no expiry.

- [ ] **Step 6: Run the CLI suite + lint**

Run: `npx vitest run src/cli/ && ./node_modules/.bin/biome check src/cli/commands.ts`
Expected: pass. Existing `"full"`/`"retry"` scope tests unaffected.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands.ts src/cli/commands.test.ts
git commit -m "feat(scan): thread incremental scope + freshness skip through runSourcing"
```

---

### Task 5: `scanFreshnessHours` setting

**Files:**
- Modify: `src/matching/settings-keys.ts`, `src/matching/resolve-settings.ts`
- Test: `src/matching/resolve-settings.test.ts`

**Interfaces:**
- Produces: `SCAN_FRESHNESS_SETTING = "scanFreshnessHours"`; `SCAN_FRESHNESS_HOURS_DEFAULT = 24`; `resolveScanFreshnessHours(settings: SettingsReader): number`.

- [ ] **Step 1: Write the failing test**

In `src/matching/resolve-settings.test.ts`, add:

```typescript
describe("resolveScanFreshnessHours", () => {
  it("defaults to 24 when unset", () => {
    expect(resolveScanFreshnessHours(reader({}))).toBe(SCAN_FRESHNESS_HOURS_DEFAULT);
  });
  it("uses a stored positive number", () => {
    expect(resolveScanFreshnessHours(reader({ scanFreshnessHours: "12" }))).toBe(12);
  });
  it("treats a stored 0 as 0 (disables skipping)", () => {
    expect(resolveScanFreshnessHours(reader({ scanFreshnessHours: "0" }))).toBe(0);
  });
  it("falls back to the default for a non-numeric or negative value", () => {
    expect(resolveScanFreshnessHours(reader({ scanFreshnessHours: "abc" }))).toBe(
      SCAN_FRESHNESS_HOURS_DEFAULT,
    );
    expect(resolveScanFreshnessHours(reader({ scanFreshnessHours: "-5" }))).toBe(
      SCAN_FRESHNESS_HOURS_DEFAULT,
    );
  });
});
```

Use the file's existing `reader(...)` helper (a `SettingsReader` over a plain object — see how `resolveScorerModel` is tested at `resolve-settings.test.ts:56`). Import `SCAN_FRESHNESS_HOURS_DEFAULT` and `resolveScanFreshnessHours`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/matching/resolve-settings.test.ts -t "resolveScanFreshnessHours"`
Expected: FAIL — the function and constant don't exist.

- [ ] **Step 3: Add the setting key**

In `src/matching/settings-keys.ts`, add:

```typescript
export const SCAN_FRESHNESS_SETTING = "scanFreshnessHours";
```

- [ ] **Step 4: Add the resolver**

In `src/matching/resolve-settings.ts`, add (near `resolveScorerModel`):

```typescript
import { SCAN_FRESHNESS_SETTING } from "./settings-keys";

/** Default incremental-scan freshness window: skip companies scanned within the last 24h. */
export const SCAN_FRESHNESS_HOURS_DEFAULT = 24;

/**
 * Resolve the incremental-scan freshness window (hours) from settings. A stored non-negative number
 * wins (including `0`, which disables skipping); anything unset, non-numeric, or negative falls back
 * to the default.
 */
export function resolveScanFreshnessHours(settings: SettingsReader): number {
  const raw = settings.getSetting(SCAN_FRESHNESS_SETTING)?.trim();
  if (raw === undefined || raw === "") return SCAN_FRESHNESS_HOURS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : SCAN_FRESHNESS_HOURS_DEFAULT;
}
```

(Confirm `SettingsReader` is defined/exported in this file — it is, used by `resolveScorerModel`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/matching/resolve-settings.test.ts -t "resolveScanFreshnessHours"`
Expected: PASS.

- [ ] **Step 6: Lint + commit**

Run: `./node_modules/.bin/biome check src/matching/`
```bash
git add src/matching/settings-keys.ts src/matching/resolve-settings.ts src/matching/resolve-settings.test.ts
git commit -m "feat(settings): scanFreshnessHours setting + resolver (default 24)"
```

---

### Task 6: Scope-aware server scan runner + `POST /api/scan` body

**Files:**
- Modify: `src/server/scan-runner.ts` (`createScanRunner` becomes scope-aware), `src/server/types.ts` (runner factory shape), `src/server/serve.ts` (build per-scope runner + scheduled refresh uses incremental), `src/server/app.ts` (`POST /api/scan` parses scope)
- Test: `src/server/app.test.ts`

**Interfaces:**
- Consumes: `runSourcing`/`runScan` scope + `freshnessHours` (Task 4), `resolveScanFreshnessHours` (Task 5).
- Produces: `POST /api/scan` accepts `{ scope?: "full" | "incremental" }` (default `"incremental"`), runs the corresponding scan.

- [ ] **Step 1: Write the failing test**

In `src/server/app.test.ts`, mirror the existing `POST /api/scan` and score-options tests. Add tests: (a) `POST /api/scan` with no body defaults to incremental; (b) `{ scope: "full" }` runs full; (c) an invalid scope falls back to incremental. Assert via the injected runner factory receiving the right scope. Read the file's existing scan test + `ServerDeps` injection to see how the runner is faked; sketch the assertion:

```typescript
it("POST /api/scan defaults to incremental scope", async () => {
  const scopes: string[] = [];
  const app = makeApp({ // the file's existing app-builder helper
    runScanForScope: (scope) => {
      scopes.push(scope);
      return async () => ({ count: 0, warnings: [] });
    },
  });
  await app.request("/api/scan", { method: "POST" });
  expect(scopes).toEqual(["incremental"]);
});

it("POST /api/scan honors scope:full from the body", async () => {
  const scopes: string[] = [];
  const app = makeApp({ runScanForScope: (scope) => { scopes.push(scope); return async () => ({ count: 0, warnings: [] }); } });
  await app.request("/api/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "full" }),
  });
  expect(scopes).toEqual(["full"]);
});
```

NOTE: the exact `ServerDeps` shape changes in this task (from `runScan: ScanRunner` to a scope→runner factory). Match whatever you name it consistently across `types.ts`, `serve.ts`, `app.ts`, and the test.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/app.test.ts -t "POST /api/scan defaults to incremental"`
Expected: FAIL — no scope parsing / factory yet.

- [ ] **Step 3: Make `createScanRunner` scope-aware (curried)**

In `src/server/scan-runner.ts`, change `createScanRunner` to take the scope and freshness, mirroring `createScoreRun(options)`:

```typescript
export function createScanRunner(repo: Repository) {
  return (scope: "full" | "incremental"): ScanRunner =>
    async (onProgress) => {
      const profile = repo.getLatestProfile();
      if (!profile) throw new Error("No profile yet. Upload a resume first.");

      const dictionary = repo.getSkillDictionary();
      const scorer = new HeuristicScorer(dictionary.length > 0 ? dictionary : undefined);
      const fetcher = new HttpFetcher();
      const feed = resolvePostingFeed(repo, fetcher);
      const settings = settingsWithEnvKey(repo);

      const result = await runScan(
        {
          repo,
          profile,
          scorer,
          ...(feed ? { feed } : {}),
          scope,
          ...(scope === "incremental"
            ? { freshnessHours: resolveScanFreshnessHours(settings) }
            : {}),
          onProgress: (event) => {
            onProgress(event);
            console.log(`${style.dim("[scan]")} ${formatProgress(event)}`);
          },
          discoverDeps: {
            fetcher,
            renderer: new PlaywrightRenderer(),
            sharedViewReader: new PlaywrightSharedViewReader(),
            shareUrl: resolveShareUrl(),
            trackedCompanies: repo.listTrackedCompanies(),
            settings,
          },
        },
        (message) => console.log(`${style.dim("[scan]")} ${message}`),
      );

      return { count: result.count, warnings: result.warnings };
    };
}
```

Add `import { resolveScanFreshnessHours, settingsWithEnvKey } from "@app/matching/resolve-settings";` (settingsWithEnvKey is already imported — add resolveScanFreshnessHours to it). Leave `createRetryFailedScanRunner` unchanged.

- [ ] **Step 4: Update `ServerDeps` / `serve.ts` wiring**

In `src/server/types.ts`, change `runScan: ScanRunner` to a factory, e.g.:

```typescript
  /** Build a scan runner for the given scope (`"full"` or `"incremental"`). */
  runScanForScope: (scope: "full" | "incremental") => ScanRunner;
```

In `src/server/serve.ts` (line ~93), change:

```typescript
  const runScanForScope = createScanRunner(repo);
  const retryFailedScan = createRetryFailedScanRunner(repo);
```

and pass `runScanForScope` into the app deps. The scheduled auto-refresh (`scheduleRefresh`, line 144) should run **incremental** (routine background refresh shouldn't re-crawl everything):

```typescript
function scheduleRefresh(jobs: ScanJobManager, runScanForScope: (scope: "full" | "incremental") => ScanRunner, hours: number): void {
  // ... existing interval logic ...
  if (!jobs.isRunning()) jobs.start(runScanForScope("incremental"));
}
```

Update the `scheduleRefresh` call site to pass `runScanForScope`.

- [ ] **Step 5: Parse scope in `POST /api/scan`**

In `src/server/app.ts`, replace the scan route (lines 283-286):

```typescript
  app.post("/api/scan", async (c) => {
    const scope = await parseScanScope(c);
    const started = jobs.start(runScanForScope(scope));
    return c.json(jobs.getStatus(), started ? 202 : 409);
  });
```

Add a parser near `parseScoreOptions` (after line 349):

```typescript
/** Parse the scan scope from the request body. Defaults to `"incremental"`; only `"full"` overrides
 *  it. A malformed body or unknown value uses the default. */
async function parseScanScope(c: {
  req: { json: () => Promise<unknown> };
}): Promise<"full" | "incremental"> {
  const body = await c.req.json().catch(() => null);
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  return record.scope === "full" ? "full" : "incremental";
}
```

Change the app's dependency reference from `runScan` to `runScanForScope` throughout `app.ts` (the retry route is unchanged).

- [ ] **Step 6: Run the server test to verify it passes**

Run: `npx vitest run src/server/app.test.ts`
Expected: PASS — default incremental, `scope:full` honored, invalid → incremental. Fix any other `app.test.ts` scan tests that constructed the old `runScan` dep (update them to `runScanForScope`).

- [ ] **Step 7: Typecheck + server suite + lint**

Run: `npm run typecheck && npx vitest run src/server/ && ./node_modules/.bin/biome check src/server/`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/server/scan-runner.ts src/server/types.ts src/server/serve.ts src/server/app.ts src/server/app.test.ts
git commit -m "feat(server): scope-aware scan runner + POST /api/scan scope (default incremental)"
```

---

### Task 7: CLI `--all` / `--freshness-hours`

**Files:**
- Modify: `src/cli/main.ts` (flag parsing + scan wiring), `src/cli/help.ts` (help text)
- Test: `src/cli/main.test.ts` if flag parsing is unit-tested there; otherwise assert via a `commands.test.ts`-level scan.

**Interfaces:**
- Consumes: `runScan` scope + `freshnessHours` (Task 4), `resolveScanFreshnessHours` (Task 5).
- Produces: `scan` defaults to incremental; `scan --all` forces full; `scan --freshness-hours N` overrides the window for that run.

- [ ] **Step 1: Write the failing test**

Read how `src/cli/main.ts` parses flags and wires `scan` (look for the existing `--retry-failed` handling, which sets `scope: "retry"`). Add a test in the appropriate CLI test file asserting: no flag → `scope: "incremental"` with `freshnessHours` from settings; `--all` → `scope: "full"`; `--freshness-hours 6` → `freshnessHours: 6`. Mirror the existing `--retry-failed` test's structure.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/cli/ -t "freshness"` (adjust `-t` to your test name)
Expected: FAIL — flags not parsed.

- [ ] **Step 3: Parse the flags and wire scope**

In `src/cli/main.ts`, in the `scan` command handling (near the existing `--retry-failed` → `scope: "retry"` logic): default `scope` to `"incremental"`; if `--all` is present, use `"full"`; read `--freshness-hours N` (fall back to `resolveScanFreshnessHours(settings)`), and pass `scope` + `freshnessHours` into the `runScan`/`runSourcing` call. Reuse the file's existing flag-reading helpers (the same ones that read `--limit`/`--min-heuristic` for `score`).

- [ ] **Step 4: Update help text**

In `src/cli/help.ts`, add entries to the `scan` command's flag list:

```typescript
      ["--all", "Rescan every company, ignoring the freshness window (default: skip fresh ones)."],
      ["--freshness-hours N", "Skip companies scanned within the last N hours (default: the scanFreshnessHours setting)."],
```

(Match the existing help entry shape in the file.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/cli/`
Expected: PASS.

- [ ] **Step 6: Lint + commit**

Run: `./node_modules/.bin/biome check src/cli/`
```bash
git add src/cli/main.ts src/cli/help.ts src/cli/*.test.ts
git commit -m "feat(cli): scan --all and --freshness-hours for incremental scan"
```

---

### Task 8: Dashboard "Rescan all" toggle

**Files:**
- Modify: `web/src/api.ts` (`startScan(scope)`), `web/src/hooks.ts` (`useStartScan` passes scope), `web/src/views/Home.tsx` (checkbox + copy)
- Test: `web/src/api.test.ts`, `web/src/views/Home.test.tsx`

**Interfaces:**
- Consumes: `POST /api/scan { scope }` (Task 6).
- Produces: `api.startScan(scope: "full" | "incremental")`; a "Rescan all" checkbox that sends `"full"`, default sends `"incremental"`.

- [ ] **Step 1: Write the failing api test**

In `web/src/api.test.ts`, add a test asserting `startScan("full")` POSTs `{ scope: "full" }` and `startScan("incremental")` (or default) POSTs `{ scope: "incremental" }`. Mirror the existing `startScan`/`startDeepScore` fetch-mock tests. Assert on the `fetch` mock's body.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:web -- web/src/api.test.ts`
Expected: FAIL — `startScan` takes no scope / sends no body.

- [ ] **Step 3: Update `api.startScan`**

In `web/src/api.ts`, change `startScan` to accept a scope and send it:

```typescript
  startScan(scope: "full" | "incremental" = "incremental"): Promise<ScanJobStatus> {
    return postJson("/api/scan", { scope }, ScanJobStatusSchema, [202, 409]);
  },
```

(Match the file's actual helper names — `postJson`/schema/accepted-status pattern used by `startDeepScore`.) No `ScanJobStatusSchema` field change is needed (the response shape is unchanged), so the `api.test.ts` drift test stays green.

- [ ] **Step 4: Thread scope through the hook**

In `web/src/hooks.ts`, update `useStartScan` so its mutation accepts a scope and calls `api.startScan(scope)`. Default to `"incremental"`.

- [ ] **Step 5: Write the failing Home test**

In `web/src/views/Home.test.tsx`, add a test: rendering the scan panel shows a "Rescan all" checkbox; clicking "Scan now" with it unchecked calls the scan with `"incremental"`, and with it checked calls `"full"`. Mock the hook/api per the file's existing style.

- [ ] **Step 6: Run it to verify it fails**

Run: `npm run test:web -- web/src/views/Home.test.tsx`
Expected: FAIL — no checkbox exists.

- [ ] **Step 7: Add the checkbox + copy in `Home.tsx`**

In `web/src/views/Home.tsx`, add `const [rescanAll, setRescanAll] = useState(false);` and a checkbox beside "Scan now" (mirror the deep-score "Re-score already-scored" toggle at the same file). On click, call the scan mutation with `rescanAll ? "full" : "incremental"`. Update the panel copy to:

```tsx
<p className="mt-1 text-xs text-faint">
  Find open roles from the stillhiring.today directory and your tracked companies, then give each a
  fast, free keyword score against your resume. Skips companies checked recently — tick “Rescan all”
  to re-visit every company now.
</p>
```

- [ ] **Step 8: Run web tests to verify they pass**

Run: `npm run test:web`
Expected: PASS — api + Home tests green, drift test green.

- [ ] **Step 9: Typecheck web + lint + commit**

Run: `npm run typecheck:web && ./node_modules/.bin/biome check web/src`
```bash
git add web/src/api.ts web/src/api.test.ts web/src/hooks.ts web/src/views/Home.tsx web/src/views/Home.test.tsx
git commit -m "feat(web): Rescan all toggle for the scan panel (default incremental)"
```

---

### Task 9: Settings freshness-hours input

**Files:**
- Modify: settings API surface (`GET`/`PATCH` settings in `src/server/app.ts` + `SettingsView` in `web/src/api.ts`), `web/src/views/Settings.tsx`
- Test: `web/src/api.test.ts` (SettingsView drift), `src/server/app.test.ts` (settings round-trip)

**Interfaces:**
- Consumes: `SCAN_FRESHNESS_SETTING` (Task 5).
- Produces: `scanFreshnessHours` readable/writable via the settings API and editable in the Settings tab.

- [ ] **Step 1: Inspect the settings API shape**

Read how existing settings (e.g. `scorerModel`) are exposed: the `GET /api/settings` response (`SettingsView`) and the `PATCH`/save path in `app.ts`, plus the `SettingsView` zod schema in `web/src/api.ts`. The freshness value follows the same read/write path as `scorerModel`.

- [ ] **Step 2: Write the failing drift + round-trip tests**

In `web/src/api.test.ts`, extend the `SettingsView` fixture(s) with `scanFreshnessHours` (a number or string per the existing convention for numeric settings — match how any existing numeric/optional setting is typed). In `src/server/app.test.ts`, add a test that PATCHing `scanFreshnessHours` then GETting settings returns the new value. Run both to confirm they fail.

- [ ] **Step 3: Expose the setting in the API**

Add `scanFreshnessHours` to the `SettingsView` shape (server response builder in `app.ts`) and the zod schema in `web/src/api.ts`, and accept it in the settings-save handler (mirror `scorerModel`). Keep it optional/nullable to avoid breaking the drift test for older shapes if that's the file's convention.

- [ ] **Step 4: Add the Settings input**

In `web/src/views/Settings.tsx`, add a number input for "Scan freshness (hours)" (mirror the scorer-model field), bound to the setting, with a hint like "Skip companies scanned within this many hours on a normal scan (0 = always rescan)."

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:web && npx vitest run src/server/app.test.ts`
Expected: PASS.

- [ ] **Step 6: Typechecks + lint + commit**

Run: `npm run typecheck && npm run typecheck:web && ./node_modules/.bin/biome check .`
```bash
git add src/server/app.ts src/server/app.test.ts web/src/api.ts web/src/api.test.ts web/src/views/Settings.tsx
git commit -m "feat(settings): scanFreshnessHours in the settings API + dashboard"
```

---

### Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full CI parity**

Run: `./node_modules/.bin/biome check . && npm run typecheck && npm run typecheck:web && npm run test:coverage && npm run test:web && npm run build:web`
Expected: lint clean, both typechecks clean, server coverage ≥ 93/85/90/93, web tests pass, build clean.

- [ ] **Step 2: Confirm the expiry-safety invariant end to end**

Add/verify a test (in `commands.test.ts`) that an incremental scan which skips a company does NOT expire that company's live postings — the load-bearing correctness guarantee. If Task 4's test already covers "no expiry under incremental", confirm it also asserts a specific skipped company's postings remain non-expired after the run.

- [ ] **Step 3: Manual smoke (optional)**

`npm run cli -- serve` against a throwaway DB, run "Scan now" (incremental), confirm fresh companies are skipped in the log and the count; tick "Rescan all", confirm every company is crawled. Confidence check, not a gate.

# Expandable Lead Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `LeadSource` framework so discovery can fan out over multiple lead sources, then ship a Remotive source and a Workable ATS connector through it.

**Architecture:** Introduce a `LeadSource` interface + registry (mirroring `connectors/registry.ts`). Extract today's inline Airtable read in `discover.ts`'s `collectLeads` into an `AirtableSource`, add a `RemotiveSource`, and make `collectLeads` run every registered source (each degrades to a `Warning`, never throws) before the existing URL dedup. Separately, add a `WorkableConnector` (modeled on the JSON-feed connectors) and wire it into `resolve-ats` + the fingerprint table so any lead pointing at a Workable board resolves to it.

**Tech Stack:** TypeScript (strict, ESM), zod, vitest, Biome. Server/CLI imports via the `@app/*` alias.

## Global Constraints

- **TypeScript-strict, ESM**, target ES2022, `moduleResolution: bundler`. `noUncheckedIndexedAccess` and `noImplicitOverride` on.
- **No type assertions** except in tests. **Never** the `!` non-null assertion. Prefer existing deps/custom functions over new dependencies.
- **Biome**: 2-space indent, 100-col width, double quotes. Run `npm run lint:fix` before committing.
- **Tests colocated** (`*.test.ts` next to source), offline, dependency-injected with fixtures (`__fixtures__/`). Do NOT hard-code expected values in `expect` that you could derive from inputs.
- **Coverage gate** (vitest.config.ts): statements 93 / branches 85 / functions 90 / lines 93. Keep green.
- **Failures degrade, never crash.** Sources and connectors collect `Warning`s and return partial results — a single source or board failure must not abort discovery.
- **Commits:** Conventional Commits. Do NOT add a Claude co-authored footer.
- **`CompanyLead`** is `{ company: string; careersUrl: string; categories: string[] }` (`src/discovery/sources/types.ts`).
- **`ConnectorResult`** is `{ ok: true; postings: JobPosting[] } | { ok: false; warning: string }`.
- Verify each task with `npm run lint && npm run typecheck && npm test` before committing. Branch: `feat/expandable-lead-sources`.

---

### Task 1: `LeadSource` interface + types

**Files:**
- Modify: `src/discovery/sources/types.ts`
- Test: (none — type-only; verified by typecheck and downstream tasks)

**Interfaces:**
- Consumes: existing `CompanyLead`; `Fetcher` (`@app/net/fetcher`); `Warning` (`@app/domain/types`); `SettingsReader` (`@app/matching/resolve-settings`); `SharedViewReader` (`@app/discovery/sources/airtable`).
- Produces:
  - `type LeadSourceResult = { leads: CompanyLead[]; warnings: Warning[] }`
  - `type LeadSourceDeps = { fetcher: Fetcher; settings: SettingsReader; sharedViewReader: SharedViewReader; shareUrl: string }`
  - `interface LeadSource { readonly name: string; fetch(deps: LeadSourceDeps): Promise<LeadSourceResult> }`

- [ ] **Step 1: Add the types to `types.ts`**

Append to `src/discovery/sources/types.ts` (keep the existing `CompanyLead`):

```ts
import type { Warning } from "@app/domain/types";
import type { Fetcher } from "@app/net/fetcher";
import type { SettingsReader } from "@app/matching/resolve-settings";
import type { SharedViewReader } from "./airtable";

/** What a lead source returns: its leads plus any non-fatal warnings (it never throws). */
export type LeadSourceResult = { leads: CompanyLead[]; warnings: Warning[] };

/** Everything a lead source may need. Sources use only what they require (Remotive ignores most). */
export type LeadSourceDeps = {
  fetcher: Fetcher;
  /** For key-gated sources; a source with no key self-skips with a warning. */
  settings: SettingsReader;
  /** The Airtable shared-view reader (only the Airtable source uses these two). */
  sharedViewReader: SharedViewReader;
  shareUrl: string;
};

/**
 * A discovery lead source: produces `CompanyLead`s from some directory/aggregator. Contract mirrors
 * the connectors' — degrade to a `Warning`, never throw. Sources stay "dumb" about ATS specifics:
 * emit a careers URL and let `resolve-ats` classify it.
 */
export interface LeadSource {
  readonly name: string;
  fetch(deps: LeadSourceDeps): Promise<LeadSourceResult>;
}
```

NOTE: `import type` only — adding these imports must not create a runtime cycle (`airtable.ts` does not import `types.ts`'s new symbols). If `airtable.ts` already imports from `types.ts`, a `import type { SharedViewReader } from "./airtable"` here is a type-only edge and is fine under `isolatedModules`.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes (no consumers yet).

- [ ] **Step 3: Commit**

```bash
npm run lint:fix
git add src/discovery/sources/types.ts
git commit -m "feat(discovery): add LeadSource interface and source deps types"
```

---

### Task 2: `AirtableSource` (extract today's inline Airtable read)

**Files:**
- Create: `src/discovery/sources/airtable-source.ts`
- Test: `src/discovery/sources/airtable-source.test.ts`

**Interfaces:**
- Consumes: `LeadSource`, `LeadSourceDeps`, `LeadSourceResult` (Task 1); existing `airtableRowsToLeads`, `SharedViewReader`, `FakeSharedViewReader` (`./airtable`).
- Produces: `class AirtableSource implements LeadSource` with `name = "airtable"`. `fetch` reads the shared view via `deps.sharedViewReader.read(deps.shareUrl)`, maps with `airtableRowsToLeads`, and returns `{ leads, warnings }` — converting the optional `mapped.warning` and any thrown read error into `warnings`. Never throws.

- [ ] **Step 1: Write the failing tests**

Create `src/discovery/sources/airtable-source.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeSharedViewReader } from "./airtable";
import { AirtableSource } from "./airtable-source";
import type { LeadSourceDeps } from "./types";

/** Minimal deps; the Airtable source only touches sharedViewReader + shareUrl. */
function deps(reader: FakeSharedViewReader): LeadSourceDeps {
  return {
    fetcher: { fetch: async () => ({ statusCode: 200, bodyText: "" }) },
    settings: { getSetting: () => undefined },
    sharedViewReader: reader,
    shareUrl: "https://airtable.test/share",
  };
}

/** A minimal shared-view payload with one row that maps to a lead. */
const sharedView = {
  data: {
    primaryColumnId: "c1",
    columns: [
      { id: "c1", name: "Company" },
      { id: "c2", name: "Jobs Page" },
    ],
    rows: [{ cellValuesByColumnId: { c1: "Acme", c2: "https://boards.greenhouse.io/acme" } }],
  },
};

describe("AirtableSource", () => {
  it("maps the shared view to leads with no warnings on success", async () => {
    const source = new AirtableSource();
    const result = await source.fetch(deps(new FakeSharedViewReader(sharedView)));

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.careersUrl).toBe("https://boards.greenhouse.io/acme");
    expect(result.warnings).toEqual([]);
  });

  it("degrades to empty leads + a warning when the reader throws", async () => {
    const source = new AirtableSource();
    const error = new Error("network down");
    const result = await source.fetch(deps(new FakeSharedViewReader(error)));

    expect(result.leads).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.source).toBe("airtable");
    expect(result.warnings[0]?.message).toContain("network down");
  });

  it("surfaces the mapper's warning (e.g. unexpected shape) without throwing", async () => {
    const source = new AirtableSource();
    const result = await source.fetch(deps(new FakeSharedViewReader({ data: {} })));

    expect(result.leads).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.source).toBe("airtable");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/discovery/sources/airtable-source.test.ts`
Expected: FAIL — `AirtableSource` not found.

- [ ] **Step 3: Write the implementation**

Create `src/discovery/sources/airtable-source.ts`:

```ts
import { errorMessage } from "@app/net/error-message";
import { airtableRowsToLeads } from "./airtable";
import type { LeadSource, LeadSourceDeps, LeadSourceResult } from "./types";

const SOURCE = "airtable";

/**
 * The stillhiring.today directory as a `LeadSource`. Reads the Airtable shared view and maps it with
 * `airtableRowsToLeads`. An unreachable view or an unexpected shape degrades to empty leads plus a
 * `Warning` — never throws. (Extracted verbatim from `collectLeads`'s former inline Airtable read.)
 */
export class AirtableSource implements LeadSource {
  readonly name = SOURCE;

  async fetch(deps: LeadSourceDeps): Promise<LeadSourceResult> {
    try {
      const raw = await deps.sharedViewReader.read(deps.shareUrl);
      const mapped = airtableRowsToLeads(raw);
      const warnings = mapped.warning ? [{ source: SOURCE, message: mapped.warning }] : [];
      return { leads: mapped.leads, warnings };
    } catch (error) {
      return { leads: [], warnings: [{ source: SOURCE, message: errorMessage(error) }] };
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/discovery/sources/airtable-source.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npm run lint:fix
npm run typecheck
git add src/discovery/sources/airtable-source.ts src/discovery/sources/airtable-source.test.ts
git commit -m "feat(discovery): extract Airtable directory read into an AirtableSource"
```

---

### Task 3: `RemotiveFeed` schema + `RemotiveSource`

**Files:**
- Create: `src/discovery/sources/remotive.ts`
- Create: `src/discovery/sources/__fixtures__/remotive-jobs.json`
- Test: `src/discovery/sources/remotive.test.ts`

**Interfaces:**
- Consumes: `LeadSource`, `LeadSourceDeps`, `LeadSourceResult` (Task 1); `fetchFeed` (`@app/discovery/connectors/fetch-feed`); `CompanyLead`; `Fetcher`.
- Produces: `class RemotiveSource implements LeadSource` with `name = "remotive"`. `fetch` GETs `https://remotive.com/api/remote-jobs` via `fetchFeed`, validates with a local `RemotiveFeed` zod schema, and emits **one `CompanyLead` per job** (`company ← company_name`, `careersUrl ← url`, `categories ← [category]`). A failed/malformed response → `{ leads: [], warnings: [{ source: "remotive", message }] }`.

- [ ] **Step 1: Create the fixture**

Create `src/discovery/sources/__fixtures__/remotive-jobs.json`:

```json
{
  "jobs": [
    {
      "id": 1,
      "company_name": "Acme",
      "url": "https://boards.greenhouse.io/acme/jobs/123",
      "category": "Software Development",
      "candidate_required_location": "Worldwide"
    },
    {
      "id": 2,
      "company_name": "Globex",
      "url": "https://apply.workable.com/globex/j/ABCDEF/",
      "category": "Product",
      "candidate_required_location": "USA"
    }
  ]
}
```

- [ ] **Step 2: Write the failing tests**

Create `src/discovery/sources/remotive.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Fetcher } from "@app/net/fetcher";
import { RemotiveSource } from "./remotive";
import type { LeadSourceDeps } from "./types";

const FIXTURE = readFileSync(join(__dirname, "__fixtures__", "remotive-jobs.json"), "utf8");

/** A Fetcher returning a canned body + status, ignoring the URL. */
function fetcherReturning(bodyText: string, statusCode = 200): Fetcher {
  return { fetch: async () => ({ statusCode, bodyText }) };
}

function deps(fetcher: Fetcher): LeadSourceDeps {
  return {
    fetcher,
    settings: { getSetting: () => undefined },
    sharedViewReader: { read: async () => ({}) },
    shareUrl: "",
  };
}

describe("RemotiveSource", () => {
  it("emits one lead per job, mapping company/url/category", async () => {
    const jobs = (JSON.parse(FIXTURE) as { jobs: { company_name: string; url: string; category: string }[] }).jobs;
    const source = new RemotiveSource();

    const result = await source.fetch(deps(fetcherReturning(FIXTURE)));

    expect(result.leads).toHaveLength(jobs.length);
    expect(result.leads.map((l) => l.careersUrl)).toEqual(jobs.map((j) => j.url));
    expect(result.leads[0]?.company).toBe(jobs[0]?.company_name);
    expect(result.leads[0]?.categories).toEqual([jobs[0]?.category]);
    expect(result.warnings).toEqual([]);
  });

  it("degrades to a warning on a non-2xx response", async () => {
    const source = new RemotiveSource();
    const result = await source.fetch(deps(fetcherReturning("", 503)));

    expect(result.leads).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.source).toBe("remotive");
  });

  it("degrades to a warning on a malformed payload", async () => {
    const source = new RemotiveSource();
    const result = await source.fetch(deps(fetcherReturning('{"unexpected":true}')));

    expect(result.leads).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.source).toBe("remotive");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/discovery/sources/remotive.test.ts`
Expected: FAIL — `RemotiveSource` not found.

- [ ] **Step 4: Write the implementation**

Create `src/discovery/sources/remotive.ts`:

```ts
import { fetchFeed } from "@app/discovery/connectors/fetch-feed";
import { z } from "zod";
import type { CompanyLead } from "./types";
import type { LeadSource, LeadSourceDeps, LeadSourceResult } from "./types";

const SOURCE = "remotive";
const URL = "https://remotive.com/api/remote-jobs";

// Lenient on unknown fields; strict only on what we read. Remotive returns one row per job.
const RemotiveJob = z
  .object({
    company_name: z.string(),
    url: z.string(),
    category: z.string().optional(),
  })
  .passthrough();

const RemotiveFeed = z.object({ jobs: z.array(RemotiveJob) }).passthrough();

/**
 * Remotive remote-jobs aggregator (`remotive.com/api/remote-jobs`, free/no-auth) as a `LeadSource`.
 * Emits one `CompanyLead` per job — staying "dumb" about ATS platforms; `resolve-ats` classifies each
 * URL downstream, and `collectLeads`' URL dedup collapses repeats. Degrades to a `Warning`, never throws.
 */
export class RemotiveSource implements LeadSource {
  readonly name = SOURCE;

  async fetch(deps: LeadSourceDeps): Promise<LeadSourceResult> {
    const result = await fetchFeed(deps.fetcher, URL, RemotiveFeed);
    if (!result.ok) {
      return { leads: [], warnings: [{ source: SOURCE, message: result.warning }] };
    }
    const leads: CompanyLead[] = result.data.jobs.map((job) => ({
      company: job.company_name,
      careersUrl: job.url,
      categories: job.category ? [job.category] : [],
    }));
    return { leads, warnings: [] };
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/discovery/sources/remotive.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
npm run lint:fix
npm run typecheck
git add src/discovery/sources/remotive.ts src/discovery/sources/remotive.test.ts src/discovery/sources/__fixtures__/remotive-jobs.json
git commit -m "feat(discovery): add a Remotive lead source"
```

---

### Task 4: Source registry + `collectLeads` fan-out

**Files:**
- Create: `src/discovery/sources/registry.ts`
- Modify: `src/discovery/discover.ts` (`DiscoverDeps`, `collectLeads`)
- Test: `src/discovery/discover.test.ts` (extend), `src/discovery/sources/registry.test.ts`

**Interfaces:**
- Consumes: `LeadSource`, `LeadSourceDeps` (Task 1); `AirtableSource` (Task 2); `RemotiveSource` (Task 3).
- Produces:
  - `registry.ts`: `export const airtableSource`, `export const remotiveSource`, `export const LEAD_SOURCES: LeadSource[]` (Airtable first, Remotive second).
  - `discover.ts`: `DiscoverDeps` gains `settings: SettingsReader`; `collectLeads` runs every source in an injectable list (defaulting to `LEAD_SOURCES`), concatenates their leads with tracked-company leads, applies the existing `normalizeUrl` dedup. Accepts an optional `sources?: LeadSource[]` on `DiscoverDeps` for tests.

- [ ] **Step 1: Write the registry test**

Create `src/discovery/sources/registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LEAD_SOURCES } from "./registry";

describe("LEAD_SOURCES", () => {
  it("lists Airtable first then Remotive (dedup precedence order)", () => {
    expect(LEAD_SOURCES.map((s) => s.name)).toEqual(["airtable", "remotive"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/discovery/sources/registry.test.ts`
Expected: FAIL — `registry` not found.

- [ ] **Step 3: Write the registry**

Create `src/discovery/sources/registry.ts`:

```ts
import { AirtableSource } from "./airtable-source";
import { RemotiveSource } from "./remotive";
import type { LeadSource } from "./types";

// One shared stateless instance per source, like connectors/registry.ts.
export const airtableSource = new AirtableSource();
export const remotiveSource = new RemotiveSource();

/**
 * Lead sources run on every scan, in priority order. Order decides which lead wins a normalized-URL
 * collision (first-wins, as in `collectLeads`); Airtable is first as the canonical directory.
 */
export const LEAD_SOURCES: LeadSource[] = [airtableSource, remotiveSource];
```

- [ ] **Step 4: Run the registry test to verify it passes**

Run: `npx vitest run src/discovery/sources/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing `collectLeads` fan-out test**

IMPORTANT — `discover.test.ts` builds its deps **inline per test** (each test creates a `FakeSharedViewReader` and passes a `{ fetcher, renderer, sharedViewReader, shareUrl, trackedCompanies, ... }` object directly; there is no shared factory). Because Task 4 Step 7 makes `settings` a **required** field on `DiscoverDeps`, every existing inline deps object in this file must gain `settings: { getSetting: () => undefined }` or the file won't typecheck. Do this first: add `settings: { getSetting: () => undefined }` to each existing `discover({...})` deps literal, run the existing tests to confirm they still pass unchanged, THEN add the new fan-out tests below. For the new tests, define a small local `baseDeps()` helper (returning a fetcher, the `renderer` shape the existing tests use, a `FakeSharedViewReader({})`, `shareUrl: ""`, and `settings: { getSetting: () => undefined }`) so the two new tests stay readable.

Add (import `LeadSource` from `./sources/types`):

```ts
import type { LeadSource } from "./sources/types";

/** A source returning fixed leads (and optional warnings), for fan-out tests. */
function staticSource(name: string, leads: { company: string; careersUrl: string }[]): LeadSource {
  return {
    name,
    fetch: async () => ({
      leads: leads.map((l) => ({ ...l, categories: [] })),
      warnings: [],
    }),
  };
}

describe("collectLeads fan-out", () => {
  it("merges leads from all sources and dedups by normalized careers URL (first wins)", async () => {
    const a = staticSource("a", [{ company: "Acme-A", careersUrl: "https://x.test/acme" }]);
    const b = staticSource("b", [
      { company: "Acme-B", careersUrl: "https://x.test/acme/" }, // same URL, trailing slash
      { company: "Globex", careersUrl: "https://x.test/globex" },
    ]);

    const result = await discover({
      ...baseDeps(), // the existing test deps factory (fetcher/renderer/reader/shareUrl/settings)
      sources: [a, b],
      trackedCompanies: [],
    });

    const urls = result.companies.map((c) => c.careersUrl);
    expect(urls).toContain("https://x.test/acme"); // a's lead wins the collision
    expect(urls).not.toContain("https://x.test/acme/");
    expect(result.companies.find((c) => c.careersUrl === "https://x.test/acme")?.company).toBe("Acme-A");
    expect(urls).toContain("https://x.test/globex");
  });

  it("a failing source contributes a warning but does not abort the others", async () => {
    const ok = staticSource("ok", [{ company: "Globex", careersUrl: "https://x.test/globex" }]);
    const bad: LeadSource = {
      name: "bad",
      fetch: async () => ({ leads: [], warnings: [{ source: "bad", message: "boom" }] }),
    };

    const result = await discover({ ...baseDeps(), sources: [bad, ok], trackedCompanies: [] });

    expect(result.companies.map((c) => c.careersUrl)).toContain("https://x.test/globex");
    expect(result.warnings.some((w) => w.source === "bad" && w.message === "boom")).toBe(true);
  });
});
```

NOTE: `baseDeps()` is the small local helper you defined above for the two new tests. The existing tests keep their inline deps objects (now each with `settings` added) — do not rewrite them to use `baseDeps()`, and do not change their expectations. `baseDeps()` exists only to keep the two new fan-out tests readable.

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/discovery/discover.test.ts -t "collectLeads fan-out"`
Expected: FAIL — `sources` not accepted / `settings` missing on deps.

- [ ] **Step 7: Update `DiscoverDeps` and `collectLeads`**

In `src/discovery/discover.ts`:

Add imports:

```ts
import type { SettingsReader } from "@app/matching/resolve-settings";
import { LEAD_SOURCES } from "./sources/registry";
import type { LeadSource } from "./sources/types";
```

Add to `DiscoverDeps`:

```ts
  /** Settings reader for key-gated lead sources (threaded to each source). */
  settings: SettingsReader;
  /** Lead sources to run; defaults to the production registry. Injected for tests. */
  sources?: LeadSource[];
```

Replace the body of `collectLeads` with the fan-out (keep `normalizeUrl`, the tracked-company mapping, and the first-wins dedup exactly as they are):

```ts
async function collectLeads(
  deps: DiscoverDeps,
): Promise<{ leads: CompanyLead[]; warnings: Warning[] }> {
  const warnings: Warning[] = [];
  const sources = deps.sources ?? LEAD_SOURCES;

  const sourceDeps = {
    fetcher: deps.fetcher,
    settings: deps.settings,
    sharedViewReader: deps.sharedViewReader,
    shareUrl: deps.shareUrl,
  };

  const sourceLeads: CompanyLead[] = [];
  // Sources run in registry order so first-wins dedup is deterministic. Each degrades to warnings.
  const results = await Promise.all(sources.map((source) => source.fetch(sourceDeps)));
  for (const result of results) {
    sourceLeads.push(...result.leads);
    warnings.push(...result.warnings);
  }

  const trackedLeads: CompanyLead[] = (deps.trackedCompanies ?? []).map((tracked) => ({
    company: tracked.name ?? hostnameOf(tracked.careersUrl),
    careersUrl: tracked.careersUrl,
    categories: [],
  }));

  const byUrl = new Map<string, CompanyLead>();
  for (const lead of [...sourceLeads, ...trackedLeads]) {
    const key = normalizeUrl(lead.careersUrl);
    if (!byUrl.has(key)) byUrl.set(key, lead);
  }

  return { leads: [...byUrl.values()], warnings };
}
```

Remove the now-unused imports in `discover.ts` if they became unused: `airtableRowsToLeads` and the `SharedViewReader` type are no longer referenced by `discover.ts` directly (they moved to `AirtableSource`). Leave `SharedViewReader` in `DiscoverDeps`? — NO: `DiscoverDeps` still needs `sharedViewReader` + `shareUrl` because they're passed through to the Airtable source via `sourceDeps`. Keep those two fields and their import of the `SharedViewReader` type; remove only the `airtableRowsToLeads` import.

- [ ] **Step 8: Run the discover tests to verify they pass**

Run: `npx vitest run src/discovery/discover.test.ts`
Expected: PASS (new fan-out tests + all existing discover tests).

- [ ] **Step 9: Lint, typecheck, commit**

```bash
npm run lint:fix
npm run typecheck
git add src/discovery/sources/registry.ts src/discovery/sources/registry.test.ts src/discovery/discover.ts src/discovery/discover.test.ts
git commit -m "feat(discovery): fan collectLeads out over a lead-source registry"
```

---

### Task 5: Thread `settings` into the CLI + server scan callers

**Files:**
- Modify: `src/cli/main.ts` (`runScanCommand` — add `settings` to `discoverDeps`)
- Modify: `src/server/scan-runner.ts` (`createScanRunner` — add `settings` to `discoverDeps`)
- Test: `src/cli/main.test.ts`, `src/server/scan-job.test.ts` (update any `discoverDeps` they build)

**Interfaces:**
- Consumes: `DiscoverDeps.settings` (Task 4); `settingsWithEnvKey` (`@app/matching/resolve-settings`, already imported in both callers).
- Produces: both production scan callers pass `settings: settingsWithEnvKey(repo)` in their `discoverDeps`.

- [ ] **Step 1: Run the existing caller tests to see the gap**

Run: `npx vitest run src/cli/main.test.ts src/server/scan-job.test.ts`
Expected: may already fail to typecheck/build once Task 4 made `settings` required on `DiscoverDeps`. If they pass, the typecheck in Step 4 will catch the missing field.

- [ ] **Step 2: Add `settings` to the CLI scan's `discoverDeps`**

In `src/cli/main.ts` `runScanCommand`, the `discoverDeps` object passed to `runScan` currently has `fetcher`, `renderer`, `sharedViewReader`, `shareUrl`, `trackedCompanies`. Add:

```ts
        settings: settingsWithEnvKey(repo),
```

(`settingsWithEnvKey` is already imported in `main.ts`; if not, add `import { settingsWithEnvKey } from "@app/matching/resolve-settings";`.)

- [ ] **Step 3: Add `settings` to the server scan's `discoverDeps`**

In `src/server/scan-runner.ts` `createScanRunner`, add the same field to the `discoverDeps` object:

```ts
          settings: settingsWithEnvKey(repo),
```

(`settingsWithEnvKey` is already imported in `scan-runner.ts`.)

- [ ] **Step 4: Update caller tests that build `discoverDeps`**

Run: `npx vitest run src/cli/main.test.ts src/server/scan-job.test.ts`
If a test constructs a `DiscoverDeps`/`ScanDeps` literal directly, add `settings: { getSetting: () => undefined }` (or the repo-backed reader the test already has). Do not change unrelated assertions. If the tests inject a fake `discover` rather than real deps, no change is needed.

- [ ] **Step 5: Full suite, lint, typecheck, commit**

```bash
npm run lint:fix
npm run typecheck
npm test
git add src/cli/main.ts src/server/scan-runner.ts src/cli/main.test.ts src/server/scan-job.test.ts
git commit -m "feat(discovery): thread settings into the scan callers for lead sources"
```

---

### Task 6: `WorkableFeed` schema + `WorkableConnector` (with pagination)

**Files:**
- Modify: `src/discovery/connectors/schemas.ts` (add `WorkableFeed`)
- Create: `src/discovery/connectors/workable.ts`
- Create: `src/discovery/connectors/__fixtures__/workable-page1.json`, `workable-page2.json`
- Test: `src/discovery/connectors/workable.test.ts`

**Interfaces:**
- Consumes: `fetchFeed` (`./fetch-feed`); `makePostingId` (`../posting-id`); `AtsConnector`, `ConnectorResult` (`./types`); `Fetcher`; `JobPosting`.
- Produces:
  - `schemas.ts`: `export const WorkableFeed` / `export type WorkableFeed` — `{ results: { title, shortcode, url?, description?, location?: { city?, region?, country? } }[], nextPage?: string }`.
  - `workable.ts`: `class WorkableConnector implements AtsConnector` with `source = "workable"`. `fetchPostings(token, fetcher)` paginates `https://apply.workable.com/api/v3/accounts/{token}/jobs` following `nextPage` up to `MAX_PAGES = 10`, accumulates `results`, maps each to a `JobPosting` (id via `makePostingId({ company: token, title, url })`, `company: token`, `source: "workable"`, single `fetchedAt`), and returns `{ ok: true, postings }`. A page fetch failure returns that page's `{ ok: false, warning }`.

- [ ] **Step 1: Add the `WorkableFeed` schema**

Append to `src/discovery/connectors/schemas.ts`:

```ts
// Workable — GET https://apply.workable.com/api/v3/accounts/{token}/jobs (cursor-paginated via nextPage)
// The list carries a description; `location` is a structured object; `url` may be absent (synthesize
// from `shortcode`). `nextPage` is an opaque next-page URL/cursor when more results remain.
const WorkableJob = z
  .object({
    title: z.string(),
    shortcode: z.string(),
    url: z.string().optional(),
    description: z.string().optional(),
    location: z
      .object({
        city: z.string().nullish(),
        region: z.string().nullish(),
        country: z.string().nullish(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const WorkableFeed = z
  .object({
    results: z.array(WorkableJob),
    nextPage: z.string().nullish(),
  })
  .passthrough();
export type WorkableFeed = z.infer<typeof WorkableFeed>;
```

- [ ] **Step 2: Create the two-page fixtures**

Create `src/discovery/connectors/__fixtures__/workable-page1.json`:

```json
{
  "results": [
    {
      "title": "Senior Backend Engineer",
      "shortcode": "ABC123",
      "url": "https://apply.workable.com/acme/j/ABC123/",
      "description": "Build APIs.",
      "location": { "city": "Berlin", "country": "Germany" }
    },
    {
      "title": "Product Designer",
      "shortcode": "DEF456",
      "description": "Design things."
    }
  ],
  "nextPage": "https://apply.workable.com/api/v3/accounts/acme/jobs?page=2"
}
```

Create `src/discovery/connectors/__fixtures__/workable-page2.json`:

```json
{
  "results": [
    {
      "title": "Staff Engineer",
      "shortcode": "GHI789",
      "url": "https://apply.workable.com/acme/j/GHI789/",
      "description": "Lead.",
      "location": { "city": "Remote" }
    }
  ]
}
```

- [ ] **Step 3: Write the failing tests**

Create `src/discovery/connectors/workable.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Fetcher } from "@app/net/fetcher";
import { WorkableConnector } from "./workable";

function fixture(name: string): string {
  return readFileSync(join(__dirname, "__fixtures__", name), "utf8");
}

/** A Fetcher that serves page1 then page2 by URL, and can be told to fail a given URL. */
function pagedFetcher(opts: { failUrl?: string } = {}): Fetcher {
  return {
    fetch: async (url: string) => {
      if (opts.failUrl && url === opts.failUrl) return { statusCode: 500, bodyText: "" };
      const body = url.includes("page=2") ? fixture("workable-page2.json") : fixture("workable-page1.json");
      return { statusCode: 200, bodyText: body };
    },
  };
}

describe("WorkableConnector", () => {
  it("follows nextPage and accumulates results across pages", async () => {
    const page1 = JSON.parse(fixture("workable-page1.json")) as { results: { title: string }[] };
    const page2 = JSON.parse(fixture("workable-page2.json")) as { results: { title: string }[] };
    const connector = new WorkableConnector();

    const result = await connector.fetchPostings("acme", pagedFetcher());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.postings).toHaveLength(page1.results.length + page2.results.length);
      expect(result.postings.map((p) => p.title)).toContain(page2.results[0]?.title);
      // company is stamped with the board token for liveness re-checks.
      expect(result.postings.every((p) => p.company === "acme")).toBe(true);
    }
  });

  it("synthesizes a url from shortcode when url is absent and joins the location", async () => {
    const connector = new WorkableConnector();
    const result = await connector.fetchPostings("acme", pagedFetcher());

    expect(result.ok).toBe(true);
    if (result.ok) {
      const designer = result.postings.find((p) => p.title === "Product Designer");
      expect(designer?.url).toBe("https://apply.workable.com/acme/j/DEF456/");
      const backend = result.postings.find((p) => p.title === "Senior Backend Engineer");
      expect(backend?.location).toBe("Berlin, Germany");
    }
  });

  it("returns ok:false when a page fetch fails", async () => {
    const connector = new WorkableConnector();
    // Fail the first page request.
    const firstUrl = "https://apply.workable.com/api/v3/accounts/acme/jobs";
    const result = await connector.fetchPostings("acme", pagedFetcher({ failUrl: firstUrl }));

    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run src/discovery/connectors/workable.test.ts`
Expected: FAIL — `WorkableConnector` not found.

- [ ] **Step 5: Write the connector**

Create `src/discovery/connectors/workable.ts`:

```ts
import type { JobPosting } from "@app/domain/types";
import type { Fetcher } from "@app/net/fetcher";
import { makePostingId } from "../posting-id";
import { fetchFeed } from "./fetch-feed";
import { WorkableFeed } from "./schemas";
import type { AtsConnector, ConnectorResult } from "./types";

const MAX_PAGES = 10; // bound on cursor-following so a runaway feed can't loop forever.

/** Join a Workable structured location (city/region/country) into a single display string. */
function joinLocation(location: WorkableFeed["results"][number]["location"]): string | undefined {
  const parts = [location?.city, location?.region, location?.country].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/**
 * Connector for Workable-hosted boards (`apply.workable.com/{token}`). Workable exposes a public v3
 * JSON API (no auth) that cursor-paginates via `nextPage`; this follows it up to `MAX_PAGES`,
 * accumulating results. A page that omits `url` gets one synthesized from its `shortcode`.
 *
 * `boardToken` is the account token (first careers-URL path segment), also stamped as each posting's
 * `company` so liveness re-checks can re-derive the feed (see `connectorBySource`).
 */
export class WorkableConnector implements AtsConnector {
  readonly source = "workable";

  async fetchPostings(token: string, fetcher: Fetcher): Promise<ConnectorResult> {
    let url: string | undefined = `https://apply.workable.com/api/v3/accounts/${token}/jobs`;
    const jobs: WorkableFeed["results"] = [];

    for (let page = 0; page < MAX_PAGES && url; page += 1) {
      const result = await fetchFeed(fetcher, url, WorkableFeed);
      if (!result.ok) return result;
      jobs.push(...result.data.results);
      url = result.data.nextPage ?? undefined;
    }

    const fetchedAt = new Date();
    const postings: JobPosting[] = jobs.map((job) => {
      const url = job.url ?? `https://apply.workable.com/${token}/j/${job.shortcode}/`;
      return {
        id: makePostingId({ company: token, title: job.title, url }),
        company: token,
        title: job.title,
        url,
        source: this.source,
        description: job.description ?? "",
        location: joinLocation(job.location),
        fetchedAt,
      };
    });

    return { ok: true, postings };
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/discovery/connectors/workable.test.ts`
Expected: PASS.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
npm run lint:fix
npm run typecheck
git add src/discovery/connectors/schemas.ts src/discovery/connectors/workable.ts src/discovery/connectors/__fixtures__/workable-page1.json src/discovery/connectors/__fixtures__/workable-page2.json src/discovery/connectors/workable.test.ts
git commit -m "feat(discovery): add a paginating Workable ATS connector"
```

---

### Task 7: Wire Workable into the registry, resolver, and fingerprint table

**Files:**
- Modify: `src/discovery/connectors/registry.ts` (add `workableConnector`, include in `connectorBySource`)
- Modify: `src/discovery/resolve-ats.ts` (recognize `apply.workable.com`)
- Modify: `src/discovery/detect-ats-fingerprint.ts` (flip Workable to connector-backed)
- Test: `src/discovery/resolve-ats.test.ts`, `src/discovery/detect-ats-fingerprint.test.ts` (extend)

**Interfaces:**
- Consumes: `WorkableConnector` (Task 6).
- Produces: `export const workableConnector` in the registry, present in `connectorBySource`; `resolveAts("https://apply.workable.com/acme/...")` → `{ connector: workableConnector, boardToken: "acme" }`; the fingerprint table's `workable` entry has `connectorSource: "workable"`.

- [ ] **Step 1: Write the failing resolver test**

Add to `src/discovery/resolve-ats.test.ts`:

```ts
import { workableConnector } from "./connectors/registry";

describe("Workable resolution", () => {
  it("resolves an apply.workable.com URL to the Workable connector with the account token", () => {
    const resolved = resolveAts("https://apply.workable.com/acme/j/ABC123/");
    expect(resolved?.connector).toBe(workableConnector);
    expect(resolved?.boardToken).toBe("acme");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/discovery/resolve-ats.test.ts -t "Workable resolution"`
Expected: FAIL — `workableConnector` not exported / resolves to null.

- [ ] **Step 3: Register the connector**

In `src/discovery/connectors/registry.ts`:
- Add `import { WorkableConnector } from "./workable";`
- Add `export const workableConnector = new WorkableConnector();` with the other instances.
- Add `workableConnector` to the array inside `connectorBySource` (its token is re-derivable, so it belongs there alongside greenhouse/lever/etc.).

- [ ] **Step 4: Recognize the host in `resolve-ats`**

In `src/discovery/resolve-ats.ts`:
- Add `workableConnector` to the import list from `./connectors/registry`.
- After the existing path-token host checks (e.g. after the `careers.smartrecruiters.com` block, where `token` is already computed as `parsed.pathname.split("/").filter(Boolean)[0]`), add:

```ts
  if (host === "apply.workable.com") {
    return { connector: workableConnector, boardToken: token };
  }
```

(`token` is the first path segment — for `apply.workable.com/acme/j/ABC123/` that's `acme`, the account token.)

- [ ] **Step 5: Run the resolver test to verify it passes**

Run: `npx vitest run src/discovery/resolve-ats.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing fingerprint test**

Add to `src/discovery/detect-ats-fingerprint.test.ts`:

```ts
it("reports a workable.com embed as connector-backed", () => {
  const match = detectAtsFingerprint(
    "https://careers.acme.test",
    '<script src="https://apply.workable.com/embed.js"></script>',
  );
  expect(match?.platform).toBe("workable");
  expect(match?.connectorSource).toBe("workable");
  expect(match?.signal).toBe("embed");
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run src/discovery/detect-ats-fingerprint.test.ts -t "workable.com embed"`
Expected: FAIL — `connectorSource` is currently `null`.

- [ ] **Step 8: Flip the fingerprint entry**

In `src/discovery/detect-ats-fingerprint.ts`, move the Workable entry from the "known platforms we do NOT yet have a connector for" block up into the connector-backed block (with the other `connectorSource` entries), and set its `connectorSource` to `"workable"`:

```ts
  { platform: "workable", connectorSource: "workable", hosts: ["workable.com"] },
```

Remove the old `{ platform: "workable", connectorSource: null, hosts: ["workable.com"] }` line from the lower block. Placing it among the connector-backed entries keeps the "connector-backed first" priority ordering the file documents.

- [ ] **Step 9: Run the fingerprint test to verify it passes**

Run: `npx vitest run src/discovery/detect-ats-fingerprint.test.ts`
Expected: PASS.

- [ ] **Step 10: Full suite, lint, typecheck, commit**

```bash
npm run lint:fix
npm run typecheck
npm test
git add src/discovery/connectors/registry.ts src/discovery/resolve-ats.ts src/discovery/detect-ats-fingerprint.ts src/discovery/resolve-ats.test.ts src/discovery/detect-ats-fingerprint.test.ts
git commit -m "feat(discovery): wire Workable into the resolver, registry, and fingerprint table"
```

---

### Task 8: Document The Muse as the key-gated source pattern

**Files:**
- Modify: `docs/career-page-resources.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Add the worked-example subsection**

In `docs/career-page-resources.md`, after the "§2 Aggregator APIs" table (which already lists The Muse), add a subsection documenting the key-gated source pattern against the now-built `LeadSource` framework:

```markdown
### Worked example: a key-gated source (The Muse)

Sources that need an API key follow the same `LeadSource` contract as Remotive, plus a self-skip when
the key is unset — mirroring the LLM scorer's no-key fallback. The shape:

- **Endpoint:** `https://api-v2.themuse.com/jobs?api_key={key}&page={n}` — paginated, returns
  `{ results: [{ company: { name }, refs: { landing_page }, categories, levels }], page_count }`.
- **Key:** read from `LeadSourceDeps.settings` under a `theMuseApiKey` setting (add to
  `src/matching/settings-keys.ts`). When unset, return
  `{ leads: [], warnings: [{ source: "themuse", message: "no API key configured; skipping" }] }` —
  never an error. The source is registered unconditionally in `LEAD_SOURCES`; the key check gates it.
- **Mapping:** one `CompanyLead` per listing — `company ← results[].company.name`,
  `careersUrl ← results[].refs.landing_page`, `categories ← results[].categories[].name`. Stay dumb
  about ATS specifics; let `resolve-ats` classify the landing page.
- **Pagination:** follow `page` up to `page_count` (cap it, like the Workable connector's `MAX_PAGES`).
- **Attribution / ToS:** The Muse API key is tied to their terms — honor rate limits and attribution.

This is the template for Adzuna and USAJobs too (both key-gated): a new file under
`src/discovery/sources/`, a settings key, registration in `LEAD_SOURCES`, and the self-skip guard.
```

- [ ] **Step 2: Commit**

```bash
git add docs/career-page-resources.md
git commit -m "docs: document the key-gated lead-source pattern (The Muse)"
```

---

### Task 9: Final verification

- [ ] **Step 1: Full CI-equivalent run**

```bash
npm run lint
npm run typecheck
npm run typecheck:web
npm run test:coverage
npm run build:web
```
Expected: all pass; coverage gate green (93/85/90/93).

- [ ] **Step 2: Confirm the fan-out is wired end-to-end**

Run: `grep -rn "LEAD_SOURCES" src/discovery/discover.ts`
Expected: `collectLeads` references `LEAD_SOURCES` as the default sources.

Run: `grep -rnE "workableConnector" src/discovery/resolve-ats.ts src/discovery/connectors/registry.ts`
Expected: present in both (resolver host case + registry/`connectorBySource`).

---

## Self-Review

**Spec coverage:**
- `LeadSource` framework (interface + registry + fan-out) → Tasks 1, 4.
- `AirtableSource` extraction (no behavior change) → Task 2.
- Remotive source, one-lead-per-posting, degrade-on-failure → Task 3.
- `settings` threaded into `DiscoverDeps` + both scan callers → Tasks 4, 5.
- On-by-default, key-gated policy → realized by the framework (Task 4 passes `settings`); the gated path is documented in Task 8 (no key-gated source is built, per the spec's non-goals).
- Workable connector with internal pagination (cap 10), url-from-shortcode fallback, joinLocation → Task 6.
- Workable wired into resolve-ats + registry/`connectorBySource` + fingerprint flip → Task 7.
- Document The Muse as the key-gated pattern → Task 8.
- Dedup precedence (first-wins, Airtable first) → Task 4 registry + fan-out test.
- Tests offline/fixture-driven; coverage stays green → every task + Task 9.

**Placeholder scan:** No TBD/TODO. `baseDeps()` in Task 4 Step 5 is explicitly defined as "the existing per-file deps factory, extract one if absent" with the exact fields to include — not a placeholder, an instruction tied to the real test file's shape. All code steps show complete code.

**Type consistency:** `LeadSource`/`LeadSourceDeps`/`LeadSourceResult` defined in Task 1 are consumed unchanged in Tasks 2/3/4. `DiscoverDeps.settings: SettingsReader` (Task 4) matches what Task 5's callers pass (`settingsWithEnvKey(repo)`). `WorkableFeed` (Task 6 schema) is consumed by `WorkableConnector` (Task 6) and its `joinLocation` signature derives from the schema. `workableConnector` (Task 7 registry) matches the import added to `resolve-ats.ts` (Task 7). `source = "workable"` is consistent across the connector, `connectorBySource`, and the fingerprint `connectorSource`. `makePostingId({ company, title, url })` matches the existing connector usage.

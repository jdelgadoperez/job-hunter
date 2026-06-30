# Remote & Country Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "remote?" and "country" structured, persisted properties of a posting — extracted from ATS feeds where available — and use them to filter the Matches view/CLI, badge remote roles, and rank non-remote roles lower when the user prefers remote.

**Architecture:** Two new optional fields (`remote?: boolean`, `country?: string`) on `JobPosting`, persisted in SQLite + Postgres. Connectors that expose a structured remote flag set it; everything else falls back to the existing `isRemote()` regex via a new `resolvePostingRemote()` resolver. Country is normalized once at scan time by a new `parseCountry()` helper. Filtering is added to `/api/matches`, the repository, the dashboard, and the CLI `list` command. Scoring keeps its remote cost-gate but saves non-remote roles a penalized heuristic score instead of dropping them.

**Tech Stack:** TypeScript (strict, ESM), Zod, better-sqlite3, `postgres`, Hono, React 19 + TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-29-matches-remote-country-filters-design.md`

## Global Constraints

- TypeScript-strict, ESM, ES2022, `moduleResolution: bundler`; `noUncheckedIndexedAccess` and `noImplicitOverride` on.
- **No `!` non-null assertions. No type assertions outside tests.** Use type guards / runtime narrowing.
- No new runtime dependencies.
- Biome: 2-space indent, 100-col width, double quotes. Run `npm run lint:fix` before each commit.
- Tests colocated (`*.test.ts`), offline, fixture-driven. Coverage gate must stay green: statements 92 / branches 85 / functions 90 / lines 93.
- **Failures degrade, never crash.** Undeterminable remote/country ⇒ field is `undefined`; never throw, never drop a posting.
- **SQLite and Postgres posting shapes stay in lockstep** — a column added to one is added to the other in the same task.
- Lenient query-param parsing on `/api/matches` (bad/absent ⇒ default, no 400s).
- Conventional Commits. **No Claude co-authored footer.**
- `REMOTE_PENALTY_FACTOR = 0.6` (the non-remote heuristic penalty multiplier) is a named module constant, never an inline literal.

## File Structure

**PR 1 — data model, extraction, persistence**
- `src/domain/types.ts` (modify) — add `remote?`, `country?` to `JobPosting`.
- `src/matching/remote-filter.ts` (modify) — add `resolvePostingRemote()`.
- `src/matching/location-filter.ts` (create) — `parseCountry()` + alias/state maps.
- `src/discovery/connectors/ats-feed.ts` (modify) — `MappedJob.remote?`, thread to `JobPosting`.
- `src/discovery/connectors/schemas.ts` (modify) — add structured fields to Lever/Ashby Zod schemas.
- `src/discovery/connectors/{lever,ashby,rippling,jsonld}.ts` (modify) — map the structured remote field.
- The scan pipeline (`src/cli/commands.ts` and/or where postings are persisted) — compute `country = parseCountry(location)` before save.
- `src/storage/schema.ts` (modify) — `remote INTEGER`, `country TEXT` columns.
- `src/storage/repository.ts` (modify) — `migrate()` ALTERs, `savePosting` bindings, row→JobPosting mapper.
- `src/backend/schema.sql` (modify) — `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
- `src/backend/postgres-mappers.ts` (modify) — `PostingRow`/`PostingInsert` + mapper fns.
- `src/backend/postgres-scan-store.ts` (modify) — single + bulk upsert columns/values.

**PR 2 — remote filter + badge + CLI**
- `src/storage/repository.ts` (modify) — `ListMatchesOptions.remoteOnly`; resolved-remote post-filter + on-the-wire resolution.
- `src/server/app.ts` (modify) — read `remoteOnly` query param.
- `web/src/api.ts` (modify) — `MatchFilters.remoteOnly`, web `JobPosting.remote`.
- `web/src/views/Matches.tsx` (modify) — Remote-only toggle + Remote badge in `MatchCard`.
- `src/cli/parse.ts` + `src/cli/main.ts` (modify) — `--remote-only` on `list`.

**PR 3 — country filter + CLI**
- `src/storage/repository.ts` (modify) — `ListMatchesOptions.country`; SQL country filter.
- `src/server/app.ts` (modify) — read `country` query param.
- `web/src/api.ts` (modify) — `MatchFilters.country`, web `JobPosting.country`.
- `web/src/views/Matches.tsx` (modify) — country `<select>` from result countries.
- `src/cli/parse.ts` + `src/cli/main.ts` (modify) — `--country` on `list`.

**PR 4 — scoring penalty**
- `src/matching/heuristic-scorer.ts` (modify or via score-run) — `REMOTE_PENALTY_FACTOR` + penalty.
- `src/matching/score-run.ts` (modify) — partition remote/non-remote; penalized heuristic save.
- `src/matching/score-prompt.ts` (modify) — optional remote-preference system note.
- `README.md` (modify) — document the behavior change.

---

## PR 1 — Data model, ATS extraction, persistence

Foundation. No user-facing change; the new columns populate on the next scan.
Commit each task; open PR 1 after Task 1.7.

### Task 1.1: Add `remote?`/`country?` to the JobPosting domain type

**Files:**
- Modify: `src/domain/types.ts` (the `JobPosting` type)

**Interfaces:**
- Produces: `JobPosting.remote?: boolean`, `JobPosting.country?: string` — consumed by every later task.

- [ ] **Step 1: Add the two optional fields**

In `src/domain/types.ts`, change the `JobPosting` type so it reads:

```ts
export type JobPosting = {
  id: string;
  company: string;
  title: string;
  url: string;
  source: string;
  description: string;
  location?: string;
  remote?: boolean;
  country?: string;
  postedAt?: Date;
  fetchedAt: Date;
};
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes (the fields are optional, so no existing construction breaks).

- [ ] **Step 3: Commit**

```bash
git add src/domain/types.ts
git commit -m "feat(domain): add optional remote and country to JobPosting"
```

### Task 1.2: `resolvePostingRemote()` — structured flag wins, regex fallback

**Files:**
- Modify: `src/matching/remote-filter.ts`
- Test: `src/matching/remote-filter.test.ts`

**Interfaces:**
- Consumes: `isRemote(location?)` (existing), `JobPosting` (Task 1.1).
- Produces: `resolvePostingRemote(posting: Pick<JobPosting, "remote" | "location">): boolean`.

- [ ] **Step 1: Write the failing test**

Append to `src/matching/remote-filter.test.ts` (create it if absent, importing both functions):

```ts
import { describe, expect, it } from "vitest";
import { isRemote, resolvePostingRemote } from "./remote-filter";

describe("resolvePostingRemote", () => {
  it("trusts an explicit remote=true even when the location reads on-site", () => {
    expect(resolvePostingRemote({ remote: true, location: "New York, NY" })).toBe(true);
  });

  it("trusts an explicit remote=false even when the location reads remote", () => {
    expect(resolvePostingRemote({ remote: false, location: "Remote - US" })).toBe(false);
  });

  it("falls back to the location regex when remote is undefined", () => {
    expect(resolvePostingRemote({ location: "Remote - US" })).toBe(true);
    expect(resolvePostingRemote({ location: "New York, NY" })).toBe(false);
  });

  it("treats a blank/unknown location as remote when there is no flag", () => {
    expect(resolvePostingRemote({})).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/matching/remote-filter.test.ts`
Expected: FAIL — `resolvePostingRemote` is not exported.

- [ ] **Step 3: Implement the resolver**

Append to `src/matching/remote-filter.ts`:

```ts
import type { JobPosting } from "@app/domain/types";

/**
 * Whether a posting is remote: trust a structured flag from the ATS when present, otherwise fall
 * back to the free-text location regex. One definition of "remote" for the badge, filter, and scorer.
 */
export function resolvePostingRemote(posting: Pick<JobPosting, "remote" | "location">): boolean {
  if (posting.remote !== undefined) return posting.remote;
  return isRemote(posting.location);
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `npx vitest run src/matching/remote-filter.test.ts`
Expected: PASS (all 4 new + any existing).

- [ ] **Step 5: Lint + commit**

```bash
npm run lint:fix
git add src/matching/remote-filter.ts src/matching/remote-filter.test.ts
git commit -m "feat(matching): resolvePostingRemote — structured flag wins over location regex"
```

### Task 1.3: `parseCountry()` — normalize a location to a country label

**Files:**
- Create: `src/matching/location-filter.ts`
- Test: `src/matching/location-filter.test.ts`

**Interfaces:**
- Produces: `parseCountry(location?: string): string | undefined`.

- [ ] **Step 1: Write the failing test**

Create `src/matching/location-filter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseCountry } from "./location-filter";

describe("parseCountry", () => {
  const cases: Array<[string | undefined, string | undefined]> = [
    [undefined, undefined],
    ["", undefined],
    ["   ", undefined],
    ["Berlin, Germany", "Germany"],
    ["London, UK", "UK"],
    ["London, United Kingdom", "UK"],
    ["Remote - US", "US"],
    ["Remote (United States)", "US"],
    ["San Francisco, CA", "US"],
    ["New York, NY", "US"],
    ["Toronto, Canada", "Canada"],
    ["Toronto, ON", "Canada"],
    ["Paris, France", "France"],
    ["Anywhere", undefined],
    ["Distributed", undefined],
  ];

  for (const [input, expected] of cases) {
    it(`maps ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(parseCountry(input)).toBe(expected);
    });
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/matching/location-filter.test.ts`
Expected: FAIL — module not found / `parseCountry` not exported.

- [ ] **Step 3: Implement the helper**

Create `src/matching/location-filter.ts`:

```ts
/**
 * Normalize a free-text location to a country label, or undefined when it can't be confidently
 * determined. Conservative by design: we only map high-confidence signals (explicit country name/
 * code, or a US/Canadian state-province) and return undefined otherwise so an unknown country is
 * never guessed and never silently dropped from an unfiltered list.
 */

// Canonical label per country, keyed by every alias we accept (lowercased). ISO-2 where it reads
// well in a dropdown ("US", "UK", "CA"), full name otherwise. Extend as new feeds appear.
const COUNTRY_ALIASES: Record<string, string> = {
  us: "US",
  usa: "US",
  "u.s.": "US",
  "u.s.a.": "US",
  "united states": "US",
  "united states of america": "US",
  uk: "UK",
  "u.k.": "UK",
  "united kingdom": "UK",
  "great britain": "UK",
  canada: "Canada",
  germany: "Germany",
  deutschland: "Germany",
  france: "France",
};

// Two-letter US state codes → US. (Lowercased.)
const US_STATES = new Set(
  ("al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj " +
    "nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc").split(" "),
);

// Canadian province/territory codes → Canada. (Lowercased.)
const CA_PROVINCES = new Set("ab bc mb nb nl ns nt nu on pe qc sk yt".split(" "));

function normalizeToken(token: string): string {
  return token.trim().toLowerCase();
}

export function parseCountry(location?: string): string | undefined {
  if (location === undefined || location.trim() === "") return undefined;

  // Split on commas / parens / dashes so "Remote - US" and "Berlin, Germany" both surface the tail.
  const tokens = location
    .split(/[,()\-–—/]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // Check tokens from the end first — the country/region usually trails the city.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    if (token === undefined) continue;
    const key = normalizeToken(token);
    const alias = COUNTRY_ALIASES[key];
    if (alias !== undefined) return alias;
    if (US_STATES.has(key)) return "US";
    if (CA_PROVINCES.has(key)) return "Canada";
  }
  return undefined;
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `npx vitest run src/matching/location-filter.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Lint + commit**

```bash
npm run lint:fix
git add src/matching/location-filter.ts src/matching/location-filter.test.ts
git commit -m "feat(matching): parseCountry — normalize a location to a country label"
```

### Task 1.4: ATS connector remote extraction — Lever + Ashby schemas + map, Greenhouse assertion

**Files:**
- Modify: `src/discovery/connectors/schemas.ts` — add `workplaceType` to `LeverPosting`, `isRemote` to `AshbyJob`
- Modify: `src/discovery/connectors/ats-feed.ts` — add `remote?: boolean` to `MappedJob`, thread to `JobPosting`
- Modify: `src/discovery/connectors/lever.ts` — map `workplaceType` via helper
- Modify: `src/discovery/connectors/ashby.ts` — map `isRemote`
- Modify: `src/discovery/connectors/__fixtures__/lever.json` — add `workplaceType` to fixture entries
- Modify: `src/discovery/connectors/__fixtures__/ashby.json` — add `isRemote` to fixture entries
- Test: `src/discovery/connectors/lever.test.ts` — extend with remote/on-site/absent cases
- Test: `src/discovery/connectors/ashby.test.ts` — extend with remote/absent cases
- Test: `src/discovery/connectors/greenhouse.test.ts` — assert `remote` is `undefined` (regex-only connector)

**Interfaces:**
- Consumes: `MappedJob` (ats-feed.ts), Lever/Ashby Zod schemas (schemas.ts), `JobPosting` (Task 1.1).
- Produces: `JobPosting.remote` set from the ATS field for Lever and Ashby; `undefined` for connectors without a structured field (Greenhouse).

- [ ] **Step 1: Write the failing tests**

Add to `src/discovery/connectors/lever.test.ts`:

```ts
describe("LeverConnector — remote field", () => {
  it('maps workplaceType "remote" to remote=true', async () => {
    const feed = [
      {
        id: "r1",
        text: "Remote Role",
        hostedUrl: "https://jobs.lever.co/acme/r1",
        descriptionPlain: "desc",
        categories: { location: "Remote" },
        workplaceType: "remote",
      },
    ];
    const fetcher = new FakeFetcher({
      [ENDPOINT]: {
        statusCode: 200,
        finalUrl: ENDPOINT,
        bodyText: JSON.stringify(feed),
      },
    });
    const result = await new LeverConnector().fetchPostings("acme", fetcher);
    if (!result.ok) throw new Error("expected ok");
    expect(result.postings[0]?.remote).toBe(true);
  });

  it('maps workplaceType "office" to remote=false', async () => {
    const feed = [
      {
        id: "o1",
        text: "Office Role",
        hostedUrl: "https://jobs.lever.co/acme/o1",
        descriptionPlain: "desc",
        categories: { location: "San Francisco, CA" },
        workplaceType: "office",
      },
    ];
    const fetcher = new FakeFetcher({
      [ENDPOINT]: {
        statusCode: 200,
        finalUrl: ENDPOINT,
        bodyText: JSON.stringify(feed),
      },
    });
    const result = await new LeverConnector().fetchPostings("acme", fetcher);
    if (!result.ok) throw new Error("expected ok");
    expect(result.postings[0]?.remote).toBe(false);
  });

  it("leaves remote undefined when workplaceType is absent", async () => {
    const feed = [
      {
        id: "n1",
        text: "No Workplace Type",
        hostedUrl: "https://jobs.lever.co/acme/n1",
        descriptionPlain: "desc",
        categories: { location: "New York, NY" },
      },
    ];
    const fetcher = new FakeFetcher({
      [ENDPOINT]: {
        statusCode: 200,
        finalUrl: ENDPOINT,
        bodyText: JSON.stringify(feed),
      },
    });
    const result = await new LeverConnector().fetchPostings("acme", fetcher);
    if (!result.ok) throw new Error("expected ok");
    expect(result.postings[0]?.remote).toBeUndefined();
  });
});
```

Add to `src/discovery/connectors/ashby.test.ts`:

```ts
describe("AshbyConnector — remote field", () => {
  it("passes isRemote=true through to posting.remote", async () => {
    const feed = {
      jobs: [
        {
          id: "ar1",
          title: "Remote Engineer",
          jobUrl: "https://jobs.ashbyhq.com/acme/ar1",
          descriptionPlain: "desc",
          location: "Remote",
          isRemote: true,
        },
      ],
    };
    const fetcher = new FakeFetcher({
      [ENDPOINT]: {
        statusCode: 200,
        finalUrl: ENDPOINT,
        bodyText: JSON.stringify(feed),
      },
    });
    const result = await new AshbyConnector().fetchPostings("acme", fetcher);
    if (!result.ok) throw new Error("expected ok");
    expect(result.postings[0]?.remote).toBe(true);
  });

  it("passes isRemote=false through to posting.remote", async () => {
    const feed = {
      jobs: [
        {
          id: "ao1",
          title: "On-site Engineer",
          jobUrl: "https://jobs.ashbyhq.com/acme/ao1",
          descriptionPlain: "desc",
          location: "London, UK",
          isRemote: false,
        },
      ],
    };
    const fetcher = new FakeFetcher({
      [ENDPOINT]: {
        statusCode: 200,
        finalUrl: ENDPOINT,
        bodyText: JSON.stringify(feed),
      },
    });
    const result = await new AshbyConnector().fetchPostings("acme", fetcher);
    if (!result.ok) throw new Error("expected ok");
    expect(result.postings[0]?.remote).toBe(false);
  });

  it("leaves remote undefined when isRemote is absent", async () => {
    const feed = {
      jobs: [
        {
          id: "an1",
          title: "Unknown",
          jobUrl: "https://jobs.ashbyhq.com/acme/an1",
          descriptionPlain: "desc",
          location: "Berlin, Germany",
        },
      ],
    };
    const fetcher = new FakeFetcher({
      [ENDPOINT]: {
        statusCode: 200,
        finalUrl: ENDPOINT,
        bodyText: JSON.stringify(feed),
      },
    });
    const result = await new AshbyConnector().fetchPostings("acme", fetcher);
    if (!result.ok) throw new Error("expected ok");
    expect(result.postings[0]?.remote).toBeUndefined();
  });
});
```

Add to `src/discovery/connectors/greenhouse.test.ts` (in the existing "maps a feed into normalized postings" it block, after the existing `expect` calls):

```ts
// Greenhouse has no structured remote field — remote must always be undefined.
expect(first?.remote).toBeUndefined();
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run src/discovery/connectors/lever.test.ts src/discovery/connectors/ashby.test.ts src/discovery/connectors/greenhouse.test.ts`
Expected: FAIL — `remote` property not present on postings (undefined vs. expected boolean).

- [ ] **Step 3: Implement**

In `src/discovery/connectors/schemas.ts`, add `workplaceType` to `LeverPosting` and `isRemote` to `AshbyJob`:

```ts
const LeverPosting = z
  .object({
    text: z.string(),
    hostedUrl: z.string(),
    descriptionPlain: z.string().optional(),
    categories: z.object({ location: z.string().optional() }).passthrough().optional(),
    workplaceType: z.string().optional(),
  })
  .passthrough();

const AshbyJob = z
  .object({
    title: z.string(),
    jobUrl: z.string(),
    descriptionPlain: z.string().optional(),
    location: z.string().optional(),
    isRemote: z.boolean().optional(),
  })
  .passthrough();
```

In `src/discovery/connectors/ats-feed.ts`, add `remote?: boolean` to `MappedJob` and thread it into the produced `JobPosting`:

```ts
type MappedJob = { title: string; url: string; description: string; location?: string; remote?: boolean };

// In the postings map:
return {
  id: makePostingId({ company: opts.boardToken, title: mapped.title, url: mapped.url }),
  company: opts.boardToken,
  title: mapped.title,
  url: mapped.url,
  source: opts.source,
  description: mapped.description,
  ...(mapped.location !== undefined ? { location: mapped.location } : {}),
  ...(mapped.remote !== undefined ? { remote: mapped.remote } : {}),
  fetchedAt,
} satisfies JobPosting;
```

In `src/discovery/connectors/lever.ts`, add the `leverRemote` helper and use it in the map:

```ts
/** Map Lever's workplaceType string to a structured remote boolean, or undefined when absent. */
function leverRemote(workplaceType: string | undefined): boolean | undefined {
  if (workplaceType === undefined) return undefined;
  return workplaceType === "remote";
}

// map:
map: (posting) => ({
  title: posting.text,
  url: posting.hostedUrl,
  description: posting.descriptionPlain ?? "",
  location: posting.categories?.location,
  remote: leverRemote(posting.workplaceType),
}),
```

In `src/discovery/connectors/ashby.ts`, add `remote` to the map:

```ts
map: (job) => ({
  title: job.title,
  url: job.jobUrl,
  description: job.descriptionPlain ?? "",
  location: job.location,
  remote: job.isRemote,
}),
```

- [ ] **Step 4: Run them to confirm they pass**

Run: `npx vitest run src/discovery/connectors/lever.test.ts src/discovery/connectors/ashby.test.ts src/discovery/connectors/greenhouse.test.ts`
Expected: PASS (all existing + new cases; Greenhouse remote is `undefined`).

- [ ] **Step 5: Lint + commit**

```bash
npm run lint:fix
git add src/discovery/connectors/schemas.ts src/discovery/connectors/ats-feed.ts src/discovery/connectors/lever.ts src/discovery/connectors/ashby.ts src/discovery/connectors/lever.test.ts src/discovery/connectors/ashby.test.ts src/discovery/connectors/greenhouse.test.ts
git commit -m "feat(connectors): extract structured remote from Lever (workplaceType) and Ashby (isRemote)"
```

---

### Task 1.5: Rippling + JSON-LD remote extraction

**Files:**
- Modify: `src/discovery/connectors/schemas.ts` — add `workplaceType` to the inner location object of `RipplingJob`
- Modify: `src/discovery/connectors/rippling.ts` — compute `remote` from `locations[].workplaceType`, thread into `JobPosting`
- Modify: `src/discovery/connectors/jsonld.ts` — read `jobLocationType`, thread `remote` into produced `JobPosting`s in `extractJsonLdPostings`
- Test: `src/discovery/connectors/rippling.test.ts` — add cases for all-remote, all-on-site, and absent `workplaceType`
- Test: `src/discovery/connectors/jsonld.test.ts` — add cases for `TELECOMMUTE`, other value, and absent

**Interfaces:**
- Consumes: `RipplingJob` schema (schemas.ts), `RipplingConnector` assembly (rippling.ts), `extractJsonLdPostings` (jsonld.ts).
- Produces: `JobPosting.remote` set for Rippling and browser/JSON-LD sources.

- [ ] **Step 1: Write the failing tests**

Add to `src/discovery/connectors/rippling.test.ts`:

```ts
describe("RipplingConnector — remote field", () => {
  it("sets remote=true when any location has workplaceType REMOTE", async () => {
    const listBody = JSON.stringify({
      items: [
        {
          id: "r1",
          name: "Remote Job",
          url: "https://ats.rippling.com/slug/jobs/r1",
          locations: [{ name: "Remote (US)", workplaceType: "REMOTE" }],
        },
      ],
      page: 0,
      pageSize: 50,
      totalPages: 1,
    });
    const fetcher = new FakeFetcher({
      [LIST]: { statusCode: 200, finalUrl: LIST, bodyText: listBody },
    });
    const result = await new RipplingConnector().fetchPostings(SLUG, fetcher);
    if (!result.ok) throw new Error("expected ok");
    expect(result.postings[0]?.remote).toBe(true);
  });

  it("sets remote=false when locations are present and none are REMOTE", async () => {
    const listBody = JSON.stringify({
      items: [
        {
          id: "o1",
          name: "Office Job",
          url: "https://ats.rippling.com/slug/jobs/o1",
          locations: [{ name: "San Francisco, CA", workplaceType: "ON_SITE" }],
        },
      ],
      page: 0,
      pageSize: 50,
      totalPages: 1,
    });
    const fetcher = new FakeFetcher({
      [LIST]: { statusCode: 200, finalUrl: LIST, bodyText: listBody },
    });
    const result = await new RipplingConnector().fetchPostings(SLUG, fetcher);
    if (!result.ok) throw new Error("expected ok");
    expect(result.postings[0]?.remote).toBe(false);
  });

  it("leaves remote undefined when locations array is absent", async () => {
    const listBody = JSON.stringify({
      items: [
        {
          id: "n1",
          name: "Unknown Location",
          url: "https://ats.rippling.com/slug/jobs/n1",
        },
      ],
      page: 0,
      pageSize: 50,
      totalPages: 1,
    });
    const fetcher = new FakeFetcher({
      [LIST]: { statusCode: 200, finalUrl: LIST, bodyText: listBody },
    });
    const result = await new RipplingConnector().fetchPostings(SLUG, fetcher);
    if (!result.ok) throw new Error("expected ok");
    expect(result.postings[0]?.remote).toBeUndefined();
  });
});
```

Add to `src/discovery/connectors/jsonld.test.ts`:

```ts
describe("extractJsonLdPostings — remote field", () => {
  it('sets remote=true when jobLocationType is "TELECOMMUTE"', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      title: "Remote Engineer",
      jobLocationType: "TELECOMMUTE",
    })}</script>`;
    const [posting] = extractJsonLdPostings(html, PAGE_URL, "Acme");
    expect(posting?.remote).toBe(true);
  });

  it("sets remote=false when jobLocationType is present but not TELECOMMUTE", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      title: "Office Engineer",
      jobLocationType: "TELECOMMUTE_HYBRID",
    })}</script>`;
    const [posting] = extractJsonLdPostings(html, PAGE_URL, "Acme");
    expect(posting?.remote).toBe(false);
  });

  it("leaves remote undefined when jobLocationType is absent", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      title: "Unknown Location",
    })}</script>`;
    const [posting] = extractJsonLdPostings(html, PAGE_URL, "Acme");
    expect(posting?.remote).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run src/discovery/connectors/rippling.test.ts src/discovery/connectors/jsonld.test.ts`
Expected: FAIL — `remote` is `undefined` where a boolean is expected.

- [ ] **Step 3: Implement**

In `src/discovery/connectors/schemas.ts`, add `workplaceType` to the inner location object of `RipplingJob`:

```ts
const RipplingJob = z
  .object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    locations: z
      .array(z.object({ name: z.string(), workplaceType: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();
```

In `src/discovery/connectors/rippling.ts`, add a `resolveRipplingRemote` helper and use it in `listJobs`:

```ts
/**
 * Derive the remote flag from Rippling's per-location workplaceType array.
 * Any REMOTE location → true; locations present but all non-remote → false; absent → undefined.
 */
function resolveRipplingRemote(
  locations: { workplaceType?: string }[] | undefined,
): boolean | undefined {
  if (locations === undefined || locations.length === 0) return undefined;
  if (locations.some((l) => l.workplaceType === "REMOTE")) return true;
  // All locations have a workplaceType present → determinably on-site/hybrid.
  if (locations.every((l) => l.workplaceType !== undefined)) return false;
  return undefined;
}
```

Update `RipplingJobRef` and the job-ref push in `listJobs`:

```ts
type RipplingJobRef = { id: string; title: string; url: string; location?: string; remote?: boolean };

// In the for loop:
jobs.push({
  id: job.id,
  title: job.name,
  url: job.url,
  location: joinLocations(job.locations),
  remote: resolveRipplingRemote(job.locations),
});
```

Update the posting assembly in `fetchPostings`:

```ts
return {
  id: makePostingId({ company: slug, title: job.title, url: job.url }),
  company: slug,
  title: job.title,
  url: job.url,
  source: this.source,
  description,
  ...(job.location !== undefined ? { location: job.location } : {}),
  ...(job.remote !== undefined ? { remote: job.remote } : {}),
  fetchedAt,
} satisfies JobPosting;
```

In `src/discovery/connectors/jsonld.ts`, add a `readJobLocationType` helper and use it in `extractJsonLdPostings`:

```ts
/** Read schema.org jobLocationType; "TELECOMMUTE" → true; other present value → false; absent → undefined. */
function readJobLocationType(node: JsonLdNode): boolean | undefined {
  const value = asString(node.jobLocationType);
  if (value === undefined) return undefined;
  return value === "TELECOMMUTE";
}
```

Update `extractJsonLdPostings` to include `remote`:

```ts
postings.push({
  id: makePostingId({ company, title, url }),
  company,
  title,
  url,
  source: "browser",
  description: asString(node.description) ?? "",
  location: readLocation(node),
  ...(readJobLocationType(node) !== undefined ? { remote: readJobLocationType(node) } : {}),
  fetchedAt,
});
```

- [ ] **Step 4: Run them to confirm they pass**

Run: `npx vitest run src/discovery/connectors/rippling.test.ts src/discovery/connectors/jsonld.test.ts`
Expected: PASS (all existing + new cases).

- [ ] **Step 5: Lint + commit**

```bash
npm run lint:fix
git add src/discovery/connectors/schemas.ts src/discovery/connectors/rippling.ts src/discovery/connectors/jsonld.ts src/discovery/connectors/rippling.test.ts src/discovery/connectors/jsonld.test.ts
git commit -m "feat(connectors): extract remote from Rippling (locations workplaceType) and JSON-LD (jobLocationType)"
```

---

### Task 1.6: SQLite persistence — schema, migrate, savePosting, listScoredPostings

**Files:**
- Modify: `src/storage/schema.ts` — add `remote INTEGER` and `country TEXT` columns to the `postings` CREATE
- Modify: `src/storage/repository.ts` — `migrate()` ALTERs, `savePosting` bindings, `listScoredPostings` SELECT + row type + mapper
- Test: `src/storage/repository.test.ts` — round-trip `remote`/`country`; old-DB migration

**Interfaces:**
- Consumes: `JobPosting.remote?`, `JobPosting.country?` (Task 1.1).
- Produces: persisted `remote` (0/1/NULL) and `country` (TEXT/NULL); `listScoredPostings` restores them onto `JobPosting`.

- [ ] **Step 1: Write the failing tests**

Append to `src/storage/repository.test.ts`:

```ts
describe("remote and country persistence", () => {
  it("round-trips remote=true and country through savePosting / listScoredPostings", () => {
    const repo = newRepo();
    const p: JobPosting = {
      ...posting,
      id: "remote-1",
      remote: true,
      country: "US",
    };
    repo.savePosting(p);
    repo.saveMatchResult("remote-1", { score: 80, matchedSkills: [], missingSkills: [] });
    const [hit] = repo.listScoredPostings();
    expect(hit?.posting.remote).toBe(true);
    expect(hit?.posting.country).toBe("US");
    repo.close();
  });

  it("round-trips remote=false", () => {
    const repo = newRepo();
    const p: JobPosting = { ...posting, id: "remote-2", remote: false };
    repo.savePosting(p);
    repo.saveMatchResult("remote-2", { score: 70, matchedSkills: [], missingSkills: [] });
    const [hit] = repo.listScoredPostings();
    expect(hit?.posting.remote).toBe(false);
    repo.close();
  });

  it("returns remote and country as undefined when stored as NULL", () => {
    const repo = newRepo();
    repo.savePosting({ ...posting, id: "remote-3" }); // no remote, no country
    repo.saveMatchResult("remote-3", { score: 60, matchedSkills: [], missingSkills: [] });
    const [hit] = repo.listScoredPostings();
    expect(hit?.posting.remote).toBeUndefined();
    expect(hit?.posting.country).toBeUndefined();
    repo.close();
  });

  it("migrate() adds remote and country columns to a pre-existing on-disk DB that lacks them", () => {
    // Write a real DB file with the OLD postings schema (no remote/country), close it, then reopen
    // through Repository — its constructor runs CREATE TABLE IF NOT EXISTS (a no-op on the existing
    // table) followed by migrate(), which must ALTER in the new columns. This exercises the actual
    // upgrade path an existing user hits, not just the fresh-schema path.
    const dir = mkdtempSync(join(tmpdir(), "jobhunter-migrate-"));
    const dbPath = join(dir, "old.db");
    try {
      const old = new Database(dbPath);
      old.exec(`
        CREATE TABLE postings (
          id TEXT PRIMARY KEY,
          company TEXT NOT NULL,
          title TEXT NOT NULL,
          url TEXT NOT NULL,
          source TEXT NOT NULL,
          description TEXT NOT NULL,
          location TEXT,
          posted_at TEXT,
          fetched_at TEXT NOT NULL,
          last_seen_scan INTEGER,
          expired_at TEXT
        );
      `);
      old
        .prepare(
          "INSERT INTO postings (id, company, title, url, source, description, fetched_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("old-1", "Old Co", "Old Job", "https://old.co/1", "greenhouse", "desc", "2026-01-01T00:00:00.000Z");
      old.close();

      // Reopen through Repository — migrate() runs here and must not throw.
      const repo = new Repository(dbPath);

      // The pre-existing row reads back with remote/country undefined (the new columns are NULL).
      repo.saveMatchResult("old-1", { score: 80, matchedSkills: [], missingSkills: [] });
      const afterMigrate = repo.listScoredPostings();
      const old1 = afterMigrate.find((s) => s.posting.id === "old-1");
      expect(old1?.posting.remote).toBeUndefined();
      expect(old1?.posting.country).toBeUndefined();

      // And a new write through the migrated DB persists both columns.
      repo.savePosting({ ...posting, id: "migrated-1", remote: true, country: "Canada" });
      repo.saveMatchResult("migrated-1", { score: 55, matchedSkills: [], missingSkills: [] });
      const migrated = repo.listScoredPostings().find((s) => s.posting.id === "migrated-1");
      expect(migrated?.posting.remote).toBe(true);
      expect(migrated?.posting.country).toBe("Canada");
      repo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

Note: the test needs these imports at the top of the file (alongside the existing `Repository` import):
```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run src/storage/repository.test.ts`
Expected: FAIL — `remote`/`country` not on the row type; `savePosting` does not bind them; `listScoredPostings` does not select them.

- [ ] **Step 3: Implement**

In `src/storage/schema.ts`, add the two columns after `location`:

```ts
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS postings (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  source TEXT NOT NULL,
  description TEXT NOT NULL,
  location TEXT,
  remote INTEGER,
  country TEXT,
  posted_at TEXT,
  fetched_at TEXT NOT NULL,
  -- Incremental-scan bookkeeping: the scan that last saw this posting, and when it was judged gone.
  last_seen_scan INTEGER,
  expired_at TEXT
);
// ... rest unchanged
```

In `src/storage/repository.ts`:

1. Add two guarded ALTER blocks in `migrate()`:

```ts
if (!postingColumns.has("remote")) {
  this.db.exec("ALTER TABLE postings ADD COLUMN remote INTEGER");
}
if (!postingColumns.has("country")) {
  this.db.exec("ALTER TABLE postings ADD COLUMN country TEXT");
}
```

2. Update `savePosting` — add `remote` and `country` to the INSERT column list, VALUES, ON CONFLICT SET, and the `.run({})` bindings:

```ts
this.db
  .prepare(
    `INSERT INTO postings
       (id, company, title, url, source, description, location, remote, country,
        posted_at, fetched_at, last_seen_scan, expired_at)
     VALUES (@id, @company, @title, @url, @source, @description, @location, @remote, @country,
        @postedAt, @fetchedAt, @scanId, NULL)
     ON CONFLICT(id) DO UPDATE SET
       company = excluded.company,
       title = excluded.title,
       url = excluded.url,
       source = excluded.source,
       description = excluded.description,
       location = excluded.location,
       remote = excluded.remote,
       country = excluded.country,
       posted_at = excluded.posted_at,
       fetched_at = excluded.fetched_at,
       last_seen_scan = COALESCE(excluded.last_seen_scan, postings.last_seen_scan),
       -- Reviving a reappeared posting only when this save belongs to a scan.
       expired_at = CASE WHEN excluded.last_seen_scan IS NULL THEN postings.expired_at ELSE NULL END`,
  )
  .run({
    id: posting.id,
    company: posting.company,
    title: posting.title,
    url: posting.url,
    source: posting.source,
    description: posting.description,
    location: posting.location ?? null,
    remote: posting.remote === undefined ? null : posting.remote ? 1 : 0,
    country: posting.country ?? null,
    postedAt: posting.postedAt?.toISOString() ?? null,
    fetchedAt: posting.fetchedAt.toISOString(),
    scanId,
  });
```

3. Update `listScoredPostings` — add `p.remote, p.country` to the SELECT, extend the row type, and spread them in the mapper:

```ts
const rows = this.db
  .prepare(
    `SELECT p.id, p.company, p.title, p.url, p.source, p.description, p.location,
            p.remote, p.country,
            p.posted_at, p.fetched_at, p.expired_at,
            m.score, m.matched_skills, m.missing_skills, m.rationale,
            ua.action
     FROM match_results m
     JOIN postings p ON p.id = m.posting_id
     LEFT JOIN user_actions ua ON ua.posting_id = p.id
     WHERE m.score >= ?${opts.includeExpired ? "" : " AND p.expired_at IS NULL"}${
       opts.includeDismissed ? "" : " AND (ua.action IS NULL OR ua.action != 'dismissed')"
     }
     ORDER BY m.score DESC, p.title`,
  )
  .all(minScore) as {
  // ... existing fields ...
  remote: number | null;
  country: string | null;
  // ... existing fields ...
}[];

return rows.map((row) => ({
  posting: {
    id: row.id,
    company: row.company,
    title: row.title,
    url: row.url,
    source: row.source,
    description: row.description,
    ...(row.location ? { location: row.location } : {}),
    ...(row.remote == null ? {} : { remote: row.remote === 1 }),
    ...(row.country ? { country: row.country } : {}),
    ...(row.posted_at ? { postedAt: new Date(row.posted_at) } : {}),
    fetchedAt: new Date(row.fetched_at),
  },
  // ... rest unchanged
}));
```

- [ ] **Step 4: Run them to confirm they pass**

Run: `npx vitest run src/storage/repository.test.ts`
Expected: PASS (all existing + new cases).

- [ ] **Step 5: Lint + commit**

```bash
npm run lint:fix
git add src/storage/schema.ts src/storage/repository.ts src/storage/repository.test.ts
git commit -m "feat(storage): persist remote and country columns in SQLite with idempotent migration"
```

---

### Task 1.7: Postgres persistence — schema.sql, mappers, scan-store

**Files:**
- Modify: `src/backend/schema.sql` — add `remote boolean` and `country text` to the `postings` CREATE; append idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` blocks
- Modify: `src/backend/postgres-mappers.ts` — extend `PostingRow`, `PostingInsert`, `postingToRow`, `rowToPosting`
- Modify: `src/backend/postgres-scan-store.ts` — add `remote` and `country` to the single `savePosting` INSERT, and to the `columns` array in `savePostings`
- Test: `src/backend/postgres-mappers.test.ts` — round-trip `remote` and `country`

**Interfaces:**
- Consumes: `JobPosting.remote?`, `JobPosting.country?` (Task 1.1); `postingToRow`/`rowToPosting` contract.
- Produces: `remote` and `country` persisted/restored through the Postgres path, in lockstep with SQLite (Task 1.6).

- [ ] **Step 1: Write the failing tests**

Append to `src/backend/postgres-mappers.test.ts`:

```ts
describe("remote and country round-trip", () => {
  it("round-trips remote=true and country through postingToRow / rowToPosting", () => {
    const original = posting({ remote: true, country: "US" });
    const row = postingToRow(original);
    expect(row.remote).toBe(true);
    expect(row.country).toBe("US");
    const restored = rowToPosting(row as PostingRow);
    expect(restored.remote).toBe(true);
    expect(restored.country).toBe("US");
  });

  it("round-trips remote=false", () => {
    const original = posting({ remote: false, country: "Germany" });
    const row = postingToRow(original);
    expect(row.remote).toBe(false);
    const restored = rowToPosting(row as PostingRow);
    expect(restored.remote).toBe(false);
  });

  it("maps undefined remote/country to null in the row and omits them on restore", () => {
    const original = posting({ location: undefined, postedAt: undefined });
    const row = postingToRow(original);
    expect(row.remote).toBeNull();
    expect(row.country).toBeNull();
    const restored = rowToPosting(row as PostingRow);
    expect("remote" in restored).toBe(false);
    expect("country" in restored).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run src/backend/postgres-mappers.test.ts`
Expected: FAIL — `PostingRow`/`PostingInsert` lack `remote`/`country`; `postingToRow` does not set them.

- [ ] **Step 3: Implement**

In `src/backend/schema.sql`, add the columns inside the `CREATE TABLE` and add idempotent `ALTER` statements at the end:

```sql
create table if not exists postings (
  id text primary key,
  company text not null,
  title text not null,
  url text not null,
  source text not null,
  description text not null,
  location text,
  remote boolean,
  country text,
  posted_at timestamptz,
  fetched_at timestamptz not null,
  -- Incremental-scan bookkeeping: the scan that last saw this posting, and when it was judged gone.
  last_seen_scan bigint,
  expired_at timestamptz
);
```

Append after the existing index/RLS statements:

```sql
-- Idempotent column additions for databases that predate these columns.
alter table postings add column if not exists remote boolean;
alter table postings add column if not exists country text;
```

In `src/backend/postgres-mappers.ts`, extend `PostingRow`, `PostingInsert`, `postingToRow`, and `rowToPosting`:

```ts
export type PostingRow = {
  id: string;
  company: string;
  title: string;
  url: string;
  source: string;
  description: string;
  location: string | null;
  remote: boolean | null;
  country: string | null;
  posted_at: string | Date | null;
  fetched_at: string | Date;
};

export type PostingInsert = {
  id: string;
  company: string;
  title: string;
  url: string;
  source: string;
  description: string;
  location: string | null;
  remote: boolean | null;
  country: string | null;
  posted_at: string | null;
  fetched_at: string;
};

export function postingToRow(posting: JobPosting): PostingInsert {
  return {
    id: posting.id,
    company: posting.company,
    title: posting.title,
    url: posting.url,
    source: posting.source,
    description: posting.description,
    location: posting.location ?? null,
    remote: posting.remote ?? null,
    country: posting.country ?? null,
    posted_at: posting.postedAt ? posting.postedAt.toISOString() : null,
    fetched_at: posting.fetchedAt.toISOString(),
  };
}

export function rowToPosting(row: PostingRow): JobPosting {
  return {
    id: row.id,
    company: row.company,
    title: row.title,
    url: row.url,
    source: row.source,
    description: row.description,
    ...(row.location ? { location: row.location } : {}),
    ...(row.remote == null ? {} : { remote: row.remote }),
    ...(row.country ? { country: row.country } : {}),
    ...(row.posted_at ? { postedAt: new Date(row.posted_at) } : {}),
    fetchedAt: new Date(row.fetched_at),
  };
}
```

In `src/backend/postgres-scan-store.ts`, add `remote` and `country` to the single `savePosting` INSERT:

```ts
async savePosting(posting: JobPosting, scanId: number | null = null): Promise<void> {
  const r = postingToRow(posting);
  await this.sql`
    INSERT INTO postings
      (id, company, title, url, source, description, location, remote, country,
       posted_at, fetched_at, last_seen_scan, expired_at)
    VALUES (${r.id}, ${r.company}, ${r.title}, ${r.url}, ${r.source}, ${r.description},
       ${r.location}, ${r.remote}, ${r.country},
       ${r.posted_at}, ${r.fetched_at}, ${scanId}, NULL)
    ON CONFLICT (id) DO UPDATE SET
      company = excluded.company,
      title = excluded.title,
      url = excluded.url,
      source = excluded.source,
      description = excluded.description,
      location = excluded.location,
      remote = excluded.remote,
      country = excluded.country,
      posted_at = excluded.posted_at,
      fetched_at = excluded.fetched_at,
      last_seen_scan = COALESCE(excluded.last_seen_scan, postings.last_seen_scan),
      -- Revive a reappeared posting only when this save belongs to a scan.
      expired_at = CASE WHEN excluded.last_seen_scan IS NULL THEN postings.expired_at ELSE NULL END`;
}
```

And add `"remote"` and `"country"` to the `columns` array in `savePostings`:

```ts
const columns = [
  "id",
  "company",
  "title",
  "url",
  "source",
  "description",
  "location",
  "remote",
  "country",
  "posted_at",
  "fetched_at",
  "last_seen_scan",
] as const;
```

- [ ] **Step 4: Run them to confirm they pass**

Run: `npx vitest run src/backend/postgres-mappers.test.ts`
Expected: PASS (all existing + new cases).

- [ ] **Step 5: Lint + commit**

```bash
npm run lint:fix
git add src/backend/schema.sql src/backend/postgres-mappers.ts src/backend/postgres-scan-store.ts src/backend/postgres-mappers.test.ts
git commit -m "feat(backend): add remote and country to Postgres schema, mappers, and scan-store upsert"
```

---

### Task 1.8: Country derivation in the scan pipeline

**Files:**
- Modify: `src/cli/commands.ts` — enrich `postings` with `parseCountry(p.location)` before saving

**Interfaces:**
- Consumes: `parseCountry` (Task 1.3), `JobPosting.country?` (Task 1.1), `runSourcing` postings array (commands.ts).
- Produces: every persisted posting has `country` set when `parseCountry` can determine it from its `location`.

Note: `commands.ts` has no test for the scan pipeline's enrichment step (the test file uses a stub `runScan`). Verification is by typecheck; a targeted integration test would require spinning up the full scan pipeline against fixtures and is out of scope for this task.

- [ ] **Step 1: Add the import and enrichment**

In `src/cli/commands.ts`, add the import at the top:

```ts
import { parseCountry } from "@app/matching/location-filter";
```

In `runSourcing`, between obtaining `postings` and saving them, add the enrichment step:

```ts
// Enrich each posting with a normalized country derived from its location string.
// parseCountry is conservative: returns undefined when the location is unrecognizable.
const enriched = postings.map((p) => {
  const country = parseCountry(p.location);
  return country !== undefined ? { ...p, country } : p;
});

onProgress?.({ kind: "persisting", total: enriched.length });
if (repo.savePostings) await repo.savePostings(enriched, scanId);
else for (const posting of enriched) await repo.savePosting(posting, scanId);
```

(Replace the existing `onProgress` + `if (repo.savePostings)` block with the above.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes — `parseCountry` returns `string | undefined`, and the spread correctly produces `JobPosting`.

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands.ts
git commit -m "feat(scan): enrich postings with country derived from location before persisting"
```

---

**PR 1 boundary:** run full CI (`npm run lint && npm run typecheck && npm run typecheck:web && npm run test:coverage && npm run build:web`), then open PR 1.

---

## PR 2 — Remote filter + badge + CLI

Adds the remote post-filter to the repository, threads `remoteOnly` through the API and CLI, resolves remote on the wire, and adds the badge + toggle in the dashboard.
Commit each task; open PR 2 after Task 2.5.

### Task 2.1: `listScoredPostings` remote post-filter + resolved remote on the wire

**Files:**
- Modify: `src/storage/repository.ts` — extend `ListMatchesOptions` with `remoteOnly?: boolean`; apply JS post-filter; set `posting.remote` to the resolved value in the mapper
- Test: `src/storage/repository.test.ts` — assert `remoteOnly: true` filters by resolved remote; assert `posting.remote` is the resolved boolean (not raw stored value) in the result

**Interfaces:**
- Consumes: `resolvePostingRemote` (Task 1.2), `ListMatchesOptions`, `listScoredPostings`.
- Produces: `listScoredPostings({ remoteOnly: true })` returns only postings where `resolvePostingRemote` is true; every `ScoredPosting.posting.remote` is the resolved boolean.

- [ ] **Step 1: Write the failing tests**

Append to `src/storage/repository.test.ts`:

```ts
describe("listScoredPostings — remote filter and resolved remote on the wire", () => {
  function seedWithRemote(
    repo: Repository,
    id: string,
    score: number,
    remote: boolean | undefined,
    location?: string,
  ): void {
    repo.savePosting({
      ...posting,
      id,
      ...(remote !== undefined ? { remote } : {}),
      ...(location ? { location } : {}),
    });
    repo.saveMatchResult(id, { score, matchedSkills: [], missingSkills: [] });
  }

  it("remoteOnly=true returns only resolved-remote postings", () => {
    const repo = newRepo();
    seedWithRemote(repo, "r1", 90, true); // structured remote=true
    seedWithRemote(repo, "o1", 80, false); // structured remote=false
    seedWithRemote(repo, "r2", 70, undefined, "Remote - US"); // fallback regex resolves true
    seedWithRemote(repo, "o2", 60, undefined, "London, UK"); // fallback regex resolves false
    repo.saveMatchResult; // already called via seedWithRemote

    const all = repo.listScoredPostings(0, { remoteOnly: true });
    const ids = all.map((s) => s.posting.id).sort();
    expect(ids).toEqual(["r1", "r2"]);
    repo.close();
  });

  it("resolved remote on the wire is a definitive boolean, not the raw stored value", () => {
    const repo = newRepo();
    // Stored with no remote flag; location regex makes it remote.
    seedWithRemote(repo, "reg1", 75, undefined, "Remote - US");
    const [hit] = repo.listScoredPostings();
    // The raw stored value is undefined (NULL in SQLite), but the wire value is resolved true.
    expect(hit?.posting.remote).toBe(true);
    repo.close();
  });

  it("remoteOnly=false (default) returns all postings regardless of remote", () => {
    const repo = newRepo();
    seedWithRemote(repo, "a1", 90, true);
    seedWithRemote(repo, "b1", 80, false);
    const all = repo.listScoredPostings();
    expect(all).toHaveLength(2);
    repo.close();
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run src/storage/repository.test.ts`
Expected: FAIL — `remoteOnly` option not recognized; `posting.remote` may be raw stored value instead of resolved.

- [ ] **Step 3: Implement**

In `src/storage/repository.ts`, extend `ListMatchesOptions`:

```ts
export type ListMatchesOptions = {
  includeExpired?: boolean;
  includeDismissed?: boolean;
  remoteOnly?: boolean;
};
```

In `listScoredPostings`, after the existing SQL query, add the import and post-filter, and update the mapper to resolve remote on the wire:

Add import at the top of the file:
```ts
import { resolvePostingRemote } from "@app/matching/remote-filter";
```

In `listScoredPostings`, after the `.all(minScore)` call:

```ts
// The remote filter is applied in JS (not SQL) because resolvePostingRemote combines the stored
// remote column with the location regex fallback — semantics SQL cannot replicate faithfully.
const filtered = opts.remoteOnly
  ? rows.filter((row) =>
      resolvePostingRemote({
        remote: row.remote == null ? undefined : row.remote === 1,
        location: row.location ?? undefined,
      }),
    )
  : rows;

return filtered.map((row) => ({
  posting: {
    id: row.id,
    company: row.company,
    title: row.title,
    url: row.url,
    source: row.source,
    description: row.description,
    ...(row.location ? { location: row.location } : {}),
    // Resolve remote on the wire so the client always receives a definitive boolean.
    // The stored column stays raw; resolution happens here, once, in one place.
    remote: resolvePostingRemote({
      remote: row.remote == null ? undefined : row.remote === 1,
      location: row.location ?? undefined,
    }),
    ...(row.country ? { country: row.country } : {}),
    ...(row.posted_at ? { postedAt: new Date(row.posted_at) } : {}),
    fetchedAt: new Date(row.fetched_at),
  },
  result: {
    score: row.score,
    matchedSkills: JSON.parse(row.matched_skills) as string[],
    missingSkills: JSON.parse(row.missing_skills) as string[],
    ...(row.rationale ? { rationale: row.rationale } : {}),
  },
  action: row.action,
  expired: row.expired_at !== null,
}));
```

- [ ] **Step 4: Run them to confirm they pass**

Run: `npx vitest run src/storage/repository.test.ts`
Expected: PASS (all existing + new cases).

- [ ] **Step 5: Lint + commit**

```bash
npm run lint:fix
git add src/storage/repository.ts src/storage/repository.test.ts
git commit -m "feat(storage): remoteOnly post-filter and resolved remote on the wire in listScoredPostings"
```

---

### Task 2.2: `/api/matches?remoteOnly` query param

**Files:**
- Modify: `src/server/app.ts` — read `remoteOnly` query param and pass to `listScoredPostings`
- Test: `src/server/app.test.ts` — assert `?remoteOnly=true` filters; assert response `posting.remote` is a resolved boolean; assert non-`"true"` values degrade to no filter

**Interfaces:**
- Consumes: `ListMatchesOptions.remoteOnly` (Task 2.1), `app.ts` `/api/matches` handler.
- Produces: `GET /api/matches?remoteOnly=true` returns only resolved-remote postings with a definitive `remote` boolean.

- [ ] **Step 1: Write the failing tests**

Append to the `describe("GET /api/matches")` block in `src/server/app.test.ts`:

```ts
it("remoteOnly=true returns only resolved-remote postings", async () => {
  // Seed one remote (structured flag) and one on-site.
  repo.savePosting({
    id: "rem1",
    company: "Co",
    title: "Remote Job",
    url: "https://co.com/rem1",
    source: "lever",
    description: "desc",
    remote: true,
    fetchedAt: new Date("2026-01-01T00:00:00Z"),
  });
  repo.savePosting({
    id: "ons1",
    company: "Co",
    title: "Office Job",
    url: "https://co.com/ons1",
    source: "lever",
    description: "desc",
    remote: false,
    fetchedAt: new Date("2026-01-01T00:00:00Z"),
  });
  repo.saveMatchResult("rem1", { score: 80, matchedSkills: [], missingSkills: [] });
  repo.saveMatchResult("ons1", { score: 70, matchedSkills: [], missingSkills: [] });

  const res = await makeApp().request("/api/matches?remoteOnly=true");
  const body = await json<{ posting: { id: string; remote: boolean } }[]>(res);
  expect(body.map((s) => s.posting.id)).toEqual(["rem1"]);
  expect(body[0]?.posting.remote).toBe(true);
});

it("remoteOnly absent or non-true returns all postings", async () => {
  repo.savePosting({
    id: "mx1",
    company: "Co",
    title: "Job",
    url: "https://co.com/mx1",
    source: "lever",
    description: "desc",
    remote: true,
    fetchedAt: new Date("2026-01-01T00:00:00Z"),
  });
  repo.savePosting({
    id: "mx2",
    company: "Co",
    title: "Job 2",
    url: "https://co.com/mx2",
    source: "lever",
    description: "desc",
    remote: false,
    fetchedAt: new Date("2026-01-01T00:00:00Z"),
  });
  repo.saveMatchResult("mx1", { score: 80, matchedSkills: [], missingSkills: [] });
  repo.saveMatchResult("mx2", { score: 70, matchedSkills: [], missingSkills: [] });

  const noParam = await json<unknown[]>(await makeApp().request("/api/matches"));
  expect(noParam).toHaveLength(2);

  const nonTrue = await json<unknown[]>(await makeApp().request("/api/matches?remoteOnly=yes"));
  expect(nonTrue).toHaveLength(2);
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run src/server/app.test.ts`
Expected: FAIL — `remoteOnly` param is not read; all postings returned regardless.

- [ ] **Step 3: Implement**

In `src/server/app.ts`, update the `/api/matches` handler:

```ts
app.get("/api/matches", (c) => {
  const raw = c.req.query("minScore");
  const parsed = raw === undefined ? 0 : Number(raw);
  const minScore = Number.isFinite(parsed) ? parsed : 0;
  return c.json(
    repo.listScoredPostings(minScore, {
      includeExpired: c.req.query("includeExpired") === "true",
      includeDismissed: c.req.query("includeDismissed") === "true",
      remoteOnly: c.req.query("remoteOnly") === "true",
    }),
  );
});
```

- [ ] **Step 4: Run them to confirm they pass**

Run: `npx vitest run src/server/app.test.ts`
Expected: PASS (all existing + new cases).

- [ ] **Step 5: Lint + commit**

```bash
npm run lint:fix
git add src/server/app.ts src/server/app.test.ts
git commit -m "feat(api): add remoteOnly query param to GET /api/matches"
```

---

### Task 2.3: Web API types — `MatchFilters.remoteOnly` + `JobPosting.remote`

**Files:**
- Modify: `web/src/api.ts` — add `remoteOnly?: boolean` to `MatchFilters`; add `remote?: boolean` to `JobPosting`; set `remoteOnly` in `getMatches` params when truthy

**Interfaces:**
- Consumes: `MatchFilters`, `JobPosting`, `getMatches` (web/src/api.ts).
- Produces: the web layer can pass `remoteOnly: true` and read `posting.remote` as a boolean.

- [ ] **Step 1: Update the types and `getMatches`**

In `web/src/api.ts`, update `JobPosting`:

```ts
export type JobPosting = {
  id: string;
  company: string;
  title: string;
  url: string;
  source: string;
  description: string;
  location?: string;
  remote?: boolean;
  postedAt?: string;
  fetchedAt: string;
};
```

Update `MatchFilters`:

```ts
export type MatchFilters = {
  includeExpired?: boolean;
  includeDismissed?: boolean;
  remoteOnly?: boolean;
};
```

Update `getMatches` to set the param when truthy (following the existing `includeExpired`/`includeDismissed` convention):

```ts
getMatches: (minScore: number, filters: MatchFilters = {}) => {
  const params = new URLSearchParams({ minScore: String(minScore) });
  if (filters.includeExpired) params.set("includeExpired", "true");
  if (filters.includeDismissed) params.set("includeDismissed", "true");
  if (filters.remoteOnly) params.set("remoteOnly", "true");
  return request<ScoredPosting[]>(`/api/matches?${params}`);
},
```

- [ ] **Step 2: Typecheck the web layer**

Run: `npm run typecheck:web`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add web/src/api.ts
git commit -m "feat(web/api): add remoteOnly to MatchFilters and remote to web JobPosting type"
```

---

### Task 2.4: Matches — Remote-only toggle + Remote badge in MatchCard

**Files:**
- Modify: `web/src/views/Matches.tsx` — add `remoteOnly` state + checkbox; add Remote badge to `MatchCard` when `posting.remote` is true

**Interfaces:**
- Consumes: `MatchFilters.remoteOnly` (Task 2.3), `JobPosting.remote` (Task 2.3), `useMatches` hook.
- Produces: a "Remote only" checkbox in the filter bar; a "Remote" pill in `MatchCard` when `posting.remote === true`.

- [ ] **Step 1: Implement**

In `web/src/views/Matches.tsx`, add `remoteOnly` state and wire it into `useMatches`, and add the badge and checkbox:

```tsx
export function Matches() {
  const [minScore, setMinScore] = useState(50);
  const [includeExpired, setIncludeExpired] = useState(false);
  const [includeDismissed, setIncludeDismissed] = useState(false);
  const [remoteOnly, setRemoteOnly] = useState(false);
  const matches = useMatches(minScore, { includeExpired, includeDismissed, remoteOnly });

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* ... existing minScore slider ... */}
        <label className="flex items-center gap-1 text-sm text-muted">
          <input
            type="checkbox"
            checked={includeExpired}
            onChange={(e) => setIncludeExpired(e.target.checked)}
          />
          Show expired
        </label>
        <label className="flex items-center gap-1 text-sm text-muted">
          <input
            type="checkbox"
            checked={includeDismissed}
            onChange={(e) => setIncludeDismissed(e.target.checked)}
          />
          Show dismissed
        </label>
        <label className="flex items-center gap-1 text-sm text-muted">
          <input
            type="checkbox"
            checked={remoteOnly}
            onChange={(e) => setRemoteOnly(e.target.checked)}
          />
          Remote only
        </label>
      </div>
      {/* ... existing loading/error/empty/list ... */}
    </section>
  );
}
```

In `MatchCard`, add the Remote badge in the badges row alongside the existing "expired" pill:

```tsx
<div className="flex items-center gap-2">
  {posting.remote ? (
    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-900 dark:text-blue-200">
      Remote
    </span>
  ) : null}
  {expired ? (
    <span className="rounded-full bg-subtle px-2 py-0.5 text-xs text-muted">expired</span>
  ) : null}
  <ScorePill score={result.score} />
</div>
```

- [ ] **Step 2: Typecheck the web layer**

Run: `npm run typecheck:web`
Expected: passes.

- [ ] **Step 3: Build the dashboard**

Run: `npm run build:web`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add web/src/views/Matches.tsx
git commit -m "feat(web): add Remote-only toggle and Remote badge in MatchCard"
```

---

### Task 2.5: CLI `list --remote-only`

**Files:**
- Modify: `src/cli/parse.ts` — add `remoteOnly?: boolean` to the `list` command type; parse `--remote-only` boolean option
- Modify: `src/cli/main.ts` — thread `remoteOnly` into the `listMatches` call
- Modify: `src/cli/commands.ts` — extend `listMatches` to accept and pass `remoteOnly` to `listScoredPostings`

**Interfaces:**
- Consumes: `listScoredPostings({ remoteOnly })` (Task 2.1), `parseCli` `list` command.
- Produces: `job-hunter list --remote-only` shows only resolved-remote matches.

- [ ] **Step 1: Update `parseCli`**

In `src/cli/parse.ts`, update the `list` kind in the `Command` type:

```ts
| { kind: "list"; minScore: number; remoteOnly?: boolean }
```

Update the `list` case in `parseCli`:

```ts
case "list": {
  const { values } = parseArgs({
    args: rest,
    options: {
      "min-score": { type: "string" },
      "remote-only": { type: "boolean" },
    },
    allowPositionals: true,
  });
  const raw = values["min-score"];
  const minScore = raw === undefined ? DEFAULT_MIN_SCORE : Number(raw);
  const cmd: Extract<Command, { kind: "list" }> = {
    kind: "list",
    minScore: Number.isFinite(minScore) ? minScore : DEFAULT_MIN_SCORE,
  };
  if (values["remote-only"]) cmd.remoteOnly = true;
  return cmd;
}
```

- [ ] **Step 2: Thread through `main.ts` and `commands.ts`**

In `src/cli/main.ts`, update the `list` case dispatch:

```ts
case "list":
  listMatches(repo, command.minScore, log, { remoteOnly: command.remoteOnly });
  break;
```

In `src/cli/commands.ts`, find `listMatches` and add an optional options param (read the existing signature from the file first to preserve its exact shape, then add the param):

```ts
export function listMatches(
  repo: Repository,
  minScore: number,
  log: Logger,
  opts: { remoteOnly?: boolean } = {},
): void {
  const matches = repo.listScoredPostings(minScore, { remoteOnly: opts.remoteOnly });
  // ... rest of the existing body unchanged ...
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
npm run lint:fix
git add src/cli/parse.ts src/cli/main.ts src/cli/commands.ts
git commit -m "feat(cli): add --remote-only flag to the list command"
```

---

**PR 2 boundary:** run full CI, then open PR 2.

---

## PR 3 — Country filter + CLI

Adds SQL-level country filtering to the repository, threads `country` through the API and CLI, and adds a country dropdown populated from current results in the dashboard.
Commit each task; open PR 3 after Task 3.5.

### Task 3.1: `listScoredPostings` country SQL filter

**Files:**
- Modify: `src/storage/repository.ts` — extend `ListMatchesOptions` with `country?: string`; add SQL `AND p.country = ? COLLATE NOCASE` when set
- Test: `src/storage/repository.test.ts` — assert `{ country: "US" }` returns only US postings; case-insensitive; absent ⇒ all

**Interfaces:**
- Consumes: `ListMatchesOptions`, `listScoredPostings`.
- Produces: `listScoredPostings({ country: "US" })` returns only postings whose stored `country` matches (case-insensitive).

- [ ] **Step 1: Write the failing tests**

Append to `src/storage/repository.test.ts`:

```ts
describe("listScoredPostings — country filter", () => {
  function seedWithCountry(repo: Repository, id: string, score: number, country?: string): void {
    repo.savePosting({
      ...posting,
      id,
      ...(country ? { country } : {}),
    });
    repo.saveMatchResult(id, { score, matchedSkills: [], missingSkills: [] });
  }

  it("filters by stored country (exact match, case-insensitive)", () => {
    const repo = newRepo();
    seedWithCountry(repo, "us1", 90, "US");
    seedWithCountry(repo, "de1", 80, "Germany");
    seedWithCountry(repo, "nx1", 70); // no country

    const us = repo.listScoredPostings(0, { country: "US" });
    expect(us.map((s) => s.posting.id)).toEqual(["us1"]);

    const usLower = repo.listScoredPostings(0, { country: "us" });
    expect(usLower.map((s) => s.posting.id)).toEqual(["us1"]);

    repo.close();
  });

  it("returns all postings when country is absent", () => {
    const repo = newRepo();
    seedWithCountry(repo, "c1", 90, "US");
    seedWithCountry(repo, "c2", 80);
    const all = repo.listScoredPostings(0, {});
    expect(all).toHaveLength(2);
    repo.close();
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run src/storage/repository.test.ts`
Expected: FAIL — `country` option not recognized; all postings returned regardless.

- [ ] **Step 3: Implement**

In `src/storage/repository.ts`, extend `ListMatchesOptions`:

```ts
export type ListMatchesOptions = {
  includeExpired?: boolean;
  includeDismissed?: boolean;
  remoteOnly?: boolean;
  country?: string;
};
```

Update the SQL in `listScoredPostings` to add the country clause and bind it:

```ts
const countrySql =
  opts.country !== undefined ? " AND p.country = ? COLLATE NOCASE" : "";

// Build the positional params as a plainly-typed array — no tuple assertion needed. better-sqlite3's
// .all() is variadic over (string | number | bigint | Buffer | null), so a (string | number)[] binds
// cleanly. minScore is always first; the country param is appended only when the clause is present.
const params: (string | number)[] = [minScore];
if (opts.country !== undefined) params.push(opts.country);

const rows = this.db
  .prepare(
    `SELECT p.id, p.company, p.title, p.url, p.source, p.description, p.location,
            p.remote, p.country,
            p.posted_at, p.fetched_at, p.expired_at,
            m.score, m.matched_skills, m.missing_skills, m.rationale,
            ua.action
     FROM match_results m
     JOIN postings p ON p.id = m.posting_id
     LEFT JOIN user_actions ua ON ua.posting_id = p.id
     WHERE m.score >= ?${opts.includeExpired ? "" : " AND p.expired_at IS NULL"}${
       opts.includeDismissed ? "" : " AND (ua.action IS NULL OR ua.action != 'dismissed')"
     }${countrySql}
     ORDER BY m.score DESC, p.title`,
  )
  .all(...params) as { /* same row type as the existing query */ }[];
```

- [ ] **Step 4: Run them to confirm they pass**

Run: `npx vitest run src/storage/repository.test.ts`
Expected: PASS (all existing + new cases).

- [ ] **Step 5: Lint + commit**

```bash
npm run lint:fix
git add src/storage/repository.ts src/storage/repository.test.ts
git commit -m "feat(storage): add country SQL filter to listScoredPostings"
```

---

### Task 3.2: `/api/matches?country` query param

**Files:**
- Modify: `src/server/app.ts` — read `country` query param and pass to `listScoredPostings`
- Test: `src/server/app.test.ts` — assert `?country=US` filters; case-insensitive; absent ⇒ all

**Interfaces:**
- Consumes: `ListMatchesOptions.country` (Task 3.1), `/api/matches` handler.
- Produces: `GET /api/matches?country=US` returns only US postings.

- [ ] **Step 1: Write the failing tests**

Append to the `describe("GET /api/matches")` block in `src/server/app.test.ts`:

```ts
it("country=US filters to US postings (case-insensitive)", async () => {
  repo.savePosting({
    id: "cus1",
    company: "Co",
    title: "US Job",
    url: "https://co.com/cus1",
    source: "lever",
    description: "desc",
    country: "US",
    fetchedAt: new Date("2026-01-01T00:00:00Z"),
  });
  repo.savePosting({
    id: "cde1",
    company: "Co",
    title: "German Job",
    url: "https://co.com/cde1",
    source: "lever",
    description: "desc",
    country: "Germany",
    fetchedAt: new Date("2026-01-01T00:00:00Z"),
  });
  repo.saveMatchResult("cus1", { score: 80, matchedSkills: [], missingSkills: [] });
  repo.saveMatchResult("cde1", { score: 70, matchedSkills: [], missingSkills: [] });

  const res = await makeApp().request("/api/matches?country=US");
  const body = await json<{ posting: { id: string } }[]>(res);
  expect(body.map((s) => s.posting.id)).toEqual(["cus1"]);

  // Case-insensitive
  const lower = await json<{ posting: { id: string } }[]>(
    await makeApp().request("/api/matches?country=us"),
  );
  expect(lower.map((s) => s.posting.id)).toEqual(["cus1"]);

  // Absent param → all
  const all = await json<unknown[]>(await makeApp().request("/api/matches"));
  expect(all).toHaveLength(2);
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run src/server/app.test.ts`
Expected: FAIL — `country` param not read; all postings returned.

- [ ] **Step 3: Implement**

In `src/server/app.ts`, update the `/api/matches` handler:

```ts
app.get("/api/matches", (c) => {
  const raw = c.req.query("minScore");
  const parsed = raw === undefined ? 0 : Number(raw);
  const minScore = Number.isFinite(parsed) ? parsed : 0;
  const country = c.req.query("country") || undefined;
  return c.json(
    repo.listScoredPostings(minScore, {
      includeExpired: c.req.query("includeExpired") === "true",
      includeDismissed: c.req.query("includeDismissed") === "true",
      remoteOnly: c.req.query("remoteOnly") === "true",
      country,
    }),
  );
});
```

- [ ] **Step 4: Run them to confirm they pass**

Run: `npx vitest run src/server/app.test.ts`
Expected: PASS (all existing + new cases).

- [ ] **Step 5: Lint + commit**

```bash
npm run lint:fix
git add src/server/app.ts src/server/app.test.ts
git commit -m "feat(api): add country query param to GET /api/matches"
```

---

### Task 3.3: Web API types — `MatchFilters.country` + `JobPosting.country`

**Files:**
- Modify: `web/src/api.ts` — add `country?: string` to `MatchFilters` and `JobPosting`; set `country` in `getMatches` params when truthy

**Interfaces:**
- Consumes: `MatchFilters`, `JobPosting`, `getMatches`.
- Produces: the web layer can pass `country: "US"` and read `posting.country` as a string.

- [ ] **Step 1: Update the types and `getMatches`**

In `web/src/api.ts`, add `country?: string` to `JobPosting` (after `remote?`):

```ts
export type JobPosting = {
  // ... existing fields ...
  remote?: boolean;
  country?: string;
  // ... existing fields ...
};
```

Add `country?: string` to `MatchFilters`:

```ts
export type MatchFilters = {
  includeExpired?: boolean;
  includeDismissed?: boolean;
  remoteOnly?: boolean;
  country?: string;
};
```

Update `getMatches`:

```ts
getMatches: (minScore: number, filters: MatchFilters = {}) => {
  const params = new URLSearchParams({ minScore: String(minScore) });
  if (filters.includeExpired) params.set("includeExpired", "true");
  if (filters.includeDismissed) params.set("includeDismissed", "true");
  if (filters.remoteOnly) params.set("remoteOnly", "true");
  if (filters.country) params.set("country", filters.country);
  return request<ScoredPosting[]>(`/api/matches?${params}`);
},
```

- [ ] **Step 2: Typecheck the web layer**

Run: `npm run typecheck:web`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add web/src/api.ts
git commit -m "feat(web/api): add country to MatchFilters and web JobPosting type"
```

---

### Task 3.4: Matches — Country dropdown populated from results

**Files:**
- Modify: `web/src/views/Matches.tsx` — add `country` state + `<select>` populated from distinct defined `country` values in the current results, sorted, with "All countries" default

**Interfaces:**
- Consumes: `MatchFilters.country` (Task 3.3), `ScoredPosting.posting.country`, `useMatches` hook.
- Produces: a country `<select>` above the results; selecting a country calls `setCountry`; options are derived from the currently loaded results.

- [ ] **Step 1: Implement**

In `web/src/views/Matches.tsx`, add `country` state, derive country options from results, and render the `<select>`:

```tsx
export function Matches() {
  const [minScore, setMinScore] = useState(50);
  const [includeExpired, setIncludeExpired] = useState(false);
  const [includeDismissed, setIncludeDismissed] = useState(false);
  const [remoteOnly, setRemoteOnly] = useState(false);
  const [country, setCountry] = useState<string | undefined>(undefined);
  const matches = useMatches(minScore, { includeExpired, includeDismissed, remoteOnly, country });

  // Collect distinct defined countries from the current result set, sorted.
  // Derived from results (not a fixed list) so only countries that actually appear are shown.
  const countryOptions: string[] = matches.data
    ? [...new Set(matches.data.flatMap((m) => (m.posting.country ? [m.posting.country] : [])))]
        .sort()
    : [];

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* ... existing controls ... */}
        {countryOptions.length > 0 && (
          <label className="flex items-center gap-1 text-sm text-muted">
            Country:{" "}
            <select
              value={country ?? ""}
              onChange={(e) => setCountry(e.target.value || undefined)}
              className="ml-1 rounded border border-border bg-surface px-1 py-0.5 text-sm"
            >
              <option value="">All countries</option>
              {countryOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {/* ... existing loading/error/empty/list ... */}
    </section>
  );
}
```

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck:web`
Run: `npm run build:web`
Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add web/src/views/Matches.tsx
git commit -m "feat(web): add country dropdown to Matches, options derived from current results"
```

---

### Task 3.5: CLI `list --country`

**Files:**
- Modify: `src/cli/parse.ts` — add `country?: string` to the `list` command type; parse `--country` string option
- Modify: `src/cli/main.ts` — thread `country` into the `listMatches` call
- Modify: `src/cli/commands.ts` — extend `listMatches` opts to include `country`

**Interfaces:**
- Consumes: `listScoredPostings({ country })` (Task 3.1), `parseCli` `list` command.
- Produces: `job-hunter list --country US` shows only US matches.

- [ ] **Step 1: Update `parseCli`**

In `src/cli/parse.ts`, update the `list` kind:

```ts
| { kind: "list"; minScore: number; remoteOnly?: boolean; country?: string }
```

Update the `list` case:

```ts
case "list": {
  const { values } = parseArgs({
    args: rest,
    options: {
      "min-score": { type: "string" },
      "remote-only": { type: "boolean" },
      country: { type: "string" },
    },
    allowPositionals: true,
  });
  const raw = values["min-score"];
  const minScore = raw === undefined ? DEFAULT_MIN_SCORE : Number(raw);
  const cmd: Extract<Command, { kind: "list" }> = {
    kind: "list",
    minScore: Number.isFinite(minScore) ? minScore : DEFAULT_MIN_SCORE,
  };
  if (values["remote-only"]) cmd.remoteOnly = true;
  if (values.country) cmd.country = values.country;
  return cmd;
}
```

- [ ] **Step 2: Thread through `main.ts` and `commands.ts`**

In `src/cli/main.ts`, update the `list` dispatch:

```ts
case "list":
  listMatches(repo, command.minScore, log, {
    remoteOnly: command.remoteOnly,
    country: command.country,
  });
  break;
```

In `src/cli/commands.ts`, extend `listMatches` opts:

```ts
export function listMatches(
  repo: Repository,
  minScore: number,
  log: Logger,
  opts: { remoteOnly?: boolean; country?: string } = {},
): void {
  const matches = repo.listScoredPostings(minScore, {
    remoteOnly: opts.remoteOnly,
    country: opts.country,
  });
  // ... rest of the existing body unchanged ...
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
npm run lint:fix
git add src/cli/parse.ts src/cli/main.ts src/cli/commands.ts
git commit -m "feat(cli): add --country flag to the list command"
```

---

**PR 3 boundary:** run full CI, then open PR 3.

---

## PR 4 — Remote-preference scoring penalty

Changes the remote gate from "drop non-remote" to "save penalized heuristic score", documents the behavior change, and adds an optional remote-preference note to the LLM system prompt.
Commit each task; open PR 4 after Task 4.4.

### Task 4.1: `REMOTE_PENALTY_FACTOR` + `applyRemotePenalty` in heuristic-scorer.ts

**Files:**
- Modify: `src/matching/heuristic-scorer.ts` — export `REMOTE_PENALTY_FACTOR = 0.6` and `applyRemotePenalty(result: MatchResult): MatchResult`
- Test: `src/matching/heuristic-scorer.test.ts` — assert `applyRemotePenalty` scales the score by the factor, clamps to 0, rounds; assert the constant is 0.6

**Interfaces:**
- Produces: `REMOTE_PENALTY_FACTOR` (named module constant); `applyRemotePenalty(result)` (pure transform used by `score-run.ts`).

- [ ] **Step 1: Write the failing tests**

Append to `src/matching/heuristic-scorer.test.ts`:

```ts
import { REMOTE_PENALTY_FACTOR, applyRemotePenalty } from "./heuristic-scorer";

describe("REMOTE_PENALTY_FACTOR", () => {
  it("is 0.6", () => {
    expect(REMOTE_PENALTY_FACTOR).toBe(0.6);
  });
});

describe("applyRemotePenalty", () => {
  const cases: Array<[number, number]> = [
    [100, Math.round(100 * 0.6)], // 60
    [80,  Math.round(80  * 0.6)], // 48
    [50,  Math.round(50  * 0.6)], // 30
    [0,   0],                      // clamped
    [1,   Math.round(1   * 0.6)], // rounds down to 1
  ];

  for (const [input, expected] of cases) {
    it(`score ${input} → ${expected}`, () => {
      const result = { score: input, matchedSkills: ["ts"], missingSkills: [] };
      expect(applyRemotePenalty(result).score).toBe(expected);
    });
  }

  it("does not modify matchedSkills or missingSkills", () => {
    const result = { score: 80, matchedSkills: ["typescript"], missingSkills: ["go"] };
    const penalized = applyRemotePenalty(result);
    expect(penalized.matchedSkills).toEqual(["typescript"]);
    expect(penalized.missingSkills).toEqual(["go"]);
  });

  it("clamped score is never negative", () => {
    expect(applyRemotePenalty({ score: 0, matchedSkills: [], missingSkills: [] }).score).toBe(0);
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run src/matching/heuristic-scorer.test.ts`
Expected: FAIL — `REMOTE_PENALTY_FACTOR` and `applyRemotePenalty` not exported.

- [ ] **Step 3: Implement**

Append to `src/matching/heuristic-scorer.ts`:

```ts
import type { MatchResult } from "@app/domain/types";

/**
 * The multiplier applied to a non-remote posting's heuristic score when the user prefers remote.
 * A 40% reduction keeps a strong on-site match ranked above a weak one, but below remote matches.
 * Named constant — never an inline literal.
 */
export const REMOTE_PENALTY_FACTOR = 0.6;

/**
 * Apply the remote penalty to a heuristic `MatchResult`. Pure: returns a new object with the
 * score scaled by `REMOTE_PENALTY_FACTOR` and clamped to [0, 100]. Only called by `score-run.ts`
 * for non-remote postings when `remoteOnly` is on.
 */
export function applyRemotePenalty(result: MatchResult): MatchResult {
  return {
    ...result,
    score: Math.max(0, Math.round(result.score * REMOTE_PENALTY_FACTOR)),
  };
}
```

- [ ] **Step 4: Run them to confirm they pass**

Run: `npx vitest run src/matching/heuristic-scorer.test.ts`
Expected: PASS (all existing + new cases).

- [ ] **Step 5: Lint + commit**

```bash
npm run lint:fix
git add src/matching/heuristic-scorer.ts src/matching/heuristic-scorer.test.ts
git commit -m "feat(matching): export REMOTE_PENALTY_FACTOR and applyRemotePenalty in HeuristicScorer"
```

---

### Task 4.2: `score-run.ts` — partition remote/non-remote instead of filtering

**Files:**
- Modify: `src/matching/score-run.ts` — change the `afterRemote` filter to a partition: remote candidates proceed through the existing pipeline; non-remote candidates get a penalized heuristic score saved directly
- Test: `src/matching/score-run.test.ts` — assert with `remoteOnly` on: remote → LLM deep-scored; non-remote → saved as heuristic with `REMOTE_PENALTY_FACTOR` applied; with `remoteOnly` off → unchanged (no penalty); penalized score clamped ≥ 0

**Interfaces:**
- Consumes: `resolvePostingRemote` (Task 1.2), `applyRemotePenalty` / `REMOTE_PENALTY_FACTOR` (Task 4.1), `ScoreRepo.saveMatchResult`, `runScoreRun`.
- Produces: non-remote postings appear in results ranked low rather than being absent; the LLM is never called for non-remote postings under `remoteOnly`.

- [ ] **Step 1: Write the failing tests**

Append to `src/matching/score-run.test.ts`:

```ts
import { REMOTE_PENALTY_FACTOR } from "./heuristic-scorer";

describe("runScoreRun — remote partition (remoteOnly=true)", () => {
  it("remote candidates reach the LLM deep-score; non-remote are saved with penalized heuristic", async () => {
    const remotePosting = candidate("rem", "Remote Job", 70, { location: "Remote - US" });
    const officePosting = candidate("off", "Office Job", 60, { location: "New York, NY" });
    const { repo, saved } = fakeRepo([remotePosting, officePosting]);

    await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, remoteOnly: true },
    });

    // Remote posting was deep-scored by the LLM scorer.
    const remoteSave = saved.find((s) => s.id === "rem");
    expect(remoteSave?.scorer).toBe("llm");

    // Non-remote posting was saved as heuristic with the penalty applied.
    const officeSave = saved.find((s) => s.id === "off");
    expect(officeSave?.scorer).toBe("heuristic");

    // The office posting's heuristic score is the base score * REMOTE_PENALTY_FACTOR.
    // (The fake scorer returns title.length; HeuristicScorer is injected via the repo's
    // listPostingsForScoring which supplies heuristicScore — see the candidate helper.)
    const expectedPenalizedScore = Math.max(
      0,
      Math.round(officePosting.heuristicScore * REMOTE_PENALTY_FACTOR),
    );
    expect(officeSave?.result.score).toBe(expectedPenalizedScore);
  });

  it("penalized score is clamped to 0 for a zero heuristic score", async () => {
    const officePosting = candidate("off0", "Office Zero", 0, { location: "London, UK" });
    const { repo, saved } = fakeRepo([officePosting]);

    await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, remoteOnly: true },
    });

    const officeSave = saved.find((s) => s.id === "off0");
    expect(officeSave?.result.score).toBe(0);
  });

  it("remoteOnly=false leaves all candidates going through the LLM pipeline (no penalty)", async () => {
    const remotePosting = candidate("r2", "Remote Job 2", 70, { location: "Remote - US" });
    const officePosting = candidate("o2", "Office Job 2", 60, { location: "Austin, TX" });
    const { repo, saved } = fakeRepo([remotePosting, officePosting]);

    await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, remoteOnly: false },
    });

    // Both go through LLM when remoteOnly is off.
    const scorers = saved.map((s) => s.scorer);
    expect(scorers.every((sc) => sc === "llm")).toBe(true);
    expect(saved).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run src/matching/score-run.test.ts`
Expected: FAIL — non-remote posting is currently filtered out, not penalized; `scorer` on non-remote save is missing.

- [ ] **Step 3: Implement**

In `src/matching/score-run.ts`, replace the current `afterRemote` filter with a partition:

Add imports at the top:
```ts
import { applyRemotePenalty } from "./heuristic-scorer";
import { resolvePostingRemote } from "./remote-filter";
```

Replace the block:
```ts
const afterRemote = options.remoteOnly
  ? gated.filter((c) => isRemote(c.posting.location))
  : gated;

const capped = afterRemote.slice(0, options.limit);
```

With:
```ts
// When remoteOnly is on, partition rather than filter:
//   - Remote candidates proceed through the full pipeline (triage → LLM deep-score).
//   - Non-remote candidates skip the LLM but are saved with a penalized heuristic score,
//     so they appear in Matches ranked low rather than being absent.
// When remoteOnly is off, no partition and no penalty — same pipeline as before.
let afterRemote: ScoringCandidate[];
let nonRemotePenalized: ScoringCandidate[];

if (options.remoteOnly) {
  const remoteGated = gated.filter((c) => resolvePostingRemote(c.posting));
  nonRemotePenalized = gated.filter((c) => !resolvePostingRemote(c.posting));
  afterRemote = remoteGated;
} else {
  afterRemote = gated;
  nonRemotePenalized = [];
}

const capped = afterRemote.slice(0, options.limit);
```

After the dry-run check, before the triage stage, save penalized scores for non-remote candidates:

```ts
// Save penalized heuristic scores for non-remote candidates before entering the LLM pipeline.
// These postings never reach the triager or LLM, so there's no cost and no usage-limit risk.
for (const candidate of nonRemotePenalized) {
  const base: MatchResult = {
    score: candidate.heuristicScore,
    matchedSkills: [],
    missingSkills: [],
  };
  repo.saveMatchResult(candidate.posting.id, applyRemotePenalty(base), "heuristic");
}
```

Also remove the now-redundant `isRemote` import (it was only used for the old filter); replace with the `resolvePostingRemote` import added above. Remove `import { isRemote } from "./remote-filter"` and use only `resolvePostingRemote`.

Update `ScoreStageCounts.afterRemote` semantics in the counts object (it now means "remote candidates that proceed to LLM"):

```ts
const counts: ScoreStageCounts = {
  inDb,
  afterRemote: afterRemote.length, // count of remote candidates proceeding to LLM
  afterHeuristic: gated.length,
  afterCap: capped.length,
  alreadyScoredSkipped,
  triageTitles: eligible.length,
  deepScored: 0,
};
```

- [ ] **Step 4: Run them to confirm they pass**

Run: `npx vitest run src/matching/score-run.test.ts`
Expected: PASS (all existing + new cases).

- [ ] **Step 5: Lint + commit**

```bash
npm run lint:fix
git add src/matching/score-run.ts src/matching/score-run.test.ts
git commit -m "feat(matching): partition remote/non-remote in score-run — non-remote saved with penalized heuristic score"
```

---

### Task 4.3: `score-prompt.ts` — optional remote-preference system note (polish)

**Files:**
- Modify: `src/matching/score-prompt.ts` — add optional `remoteOnly` param to `buildScorePrompt`; when true, append a one-line remote-preference note to the cacheable `system` prefix
- Modify: `src/cli/main.ts` — thread `remoteOnly` into the `buildScorePrompt` call in `runScoreCommand`
- Test: `src/matching/score-prompt.test.ts` — assert the note appears in `system` when `remoteOnly` is true; is absent when false/absent; the non-remote posting path (LLM not called for non-remote) means cache-key stability still holds for the remote candidate set

**Interfaces:**
- Consumes: `buildScorePrompt(profile, posting)` callers in `llm-scorer.ts` (unchanged — it doesn't need the flag) and `main.ts` (thread the flag). `MatchPayloadSchema` is unchanged.
- Produces: LLM-scored (remote) postings receive a system prompt that notes the user prefers remote roles, nudging the model slightly.

Note: `LlmScorer.score` calls `buildScorePrompt(profile, posting)` without a remote flag — that's correct because `LlmScorer` is only used for fallback in `llm-scorer.ts`, and under the partition, the LLM is never called for non-remote postings when `remoteOnly` is on. The flag is only needed in the direct `rawClient.score(buildScorePrompt(...))` call in `main.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `src/matching/score-prompt.test.ts`:

```ts
describe("buildScorePrompt — remoteOnly note", () => {
  it("appends a remote-preference note to system when remoteOnly=true", () => {
    const { system } = buildScorePrompt(profile, posting(), true);
    expect(system).toContain("remote");
  });

  it("does not append the note when remoteOnly=false", () => {
    const withFlag = buildScorePrompt(profile, posting(), true).system;
    const withoutFlag = buildScorePrompt(profile, posting(), false).system;
    expect(withFlag).not.toBe(withoutFlag);
    // The base (no-flag) system string is cache-stable across postings.
    expect(withoutFlag).toBe(buildScorePrompt(profile, posting({ description: "other" }), false).system);
  });

  it("omitting the flag produces the same system as remoteOnly=false (backward-compatible)", () => {
    const omitted = buildScorePrompt(profile, posting()).system;
    const explicit = buildScorePrompt(profile, posting(), false).system;
    expect(omitted).toBe(explicit);
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run src/matching/score-prompt.test.ts`
Expected: FAIL — `buildScorePrompt` does not accept a third argument; the note is never appended.

- [ ] **Step 3: Implement**

In `src/matching/score-prompt.ts`, add the optional third param:

```ts
const REMOTE_PREFERENCE_NOTE =
  "Note: the user prefers remote roles — weight remote-friendly indicators slightly higher when scores are otherwise close.";

export function buildScorePrompt(
  profile: SkillProfile,
  posting: JobPosting,
  remoteOnly = false,
): LlmScoreRequest {
  const systemBase = `${INSTRUCTIONS}\n\n## Candidate profile\n${serializeProfile(profile)}`;
  const system = remoteOnly ? `${systemBase}\n\n${REMOTE_PREFERENCE_NOTE}` : systemBase;
  return {
    system,
    user: `## Job posting\nTitle: ${posting.title}\n\nDescription:\n${posting.description}`,
  };
}
```

In `src/cli/main.ts`, thread `remoteOnly` into the `buildScorePrompt` call inside `runScoreCommand`:

```ts
const payload = await rawClient.score(buildScorePrompt(profileArg, posting, remoteOnly));
```

- [ ] **Step 4: Run them to confirm they pass**

Run: `npx vitest run src/matching/score-prompt.test.ts`
Expected: PASS (all existing + new cases).

- [ ] **Step 5: Lint + commit**

```bash
npm run lint:fix
git add src/matching/score-prompt.ts src/matching/score-prompt.test.ts src/cli/main.ts
git commit -m "feat(matching): optional remote-preference note in LLM system prompt when remoteOnly is on"
```

---

### Task 4.4: README — document the scoring behavior change

**Files:**
- Modify: `README.md` — add a note under the scoring/remote section explaining that `remoteOnly` now penalizes non-remote heuristic scores instead of dropping them, and that the Matches "Remote only" toggle is how to fully hide non-remote roles

**Interfaces:**
- Produces: users reading the README understand the changed behavior and the distinction between the scoring penalty and the dashboard toggle.

- [ ] **Step 1: Find the right place in the README**

Run: `grep -n "remote" /Users/jessdelgadoperez/projects/job-hunter/README.md | head -20`

Locate the section that describes the `score` command or `remote-only` / `config remote` behavior. Insert the note there.

- [ ] **Step 2: Add the documentation**

Add a note under the scoring section (exact location depends on what grep finds — insert after the `config remote` or `score --remote` description):

```md
**Remote-preference scoring (changed behavior):** When `remoteOnly` is enabled, non-remote postings
no longer vanish from your scored results. Instead, they receive a penalized heuristic score
(×0.6) and appear at the bottom of the Matches list — ranked low but visible. The LLM is never
called for non-remote roles under this setting, so there's no cost. Use the **Remote only** toggle
in the Matches view if you want to fully hide non-remote roles from the dashboard.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): document remote-preference scoring penalty behavior change"
```

---

**PR 4 boundary:** run full CI (`npm run lint && npm run typecheck && npm run typecheck:web && npm run test:coverage && npm run build:web`), then open PR 4.

---

## Plan self-review note

This plan covers all four PRs from the spec (`2026-06-29-matches-remote-country-filters-design.md`):

- **PR 1** (Tasks 1.1–1.8): domain types → resolver → country helper → Lever/Ashby extraction → Rippling/JSON-LD extraction → SQLite persistence → Postgres persistence → scan pipeline enrichment.
- **PR 2** (Tasks 2.1–2.5): repository remote post-filter + on-the-wire resolution → API param → web types → dashboard toggle + badge → CLI flag.
- **PR 3** (Tasks 3.1–3.5): repository country SQL filter → API param → web types → country dropdown → CLI flag.
- **PR 4** (Tasks 4.1–4.4): penalty constant + pure helper → score-run partition → LLM prompt note → README.

Every spec behavior listed in the design doc is addressed. No spec items are deferred or skipped.

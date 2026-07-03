# Location-fit Deep-scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Ashby mis-flagging Hybrid roles as Remote, add a home-country preference (resume-detected, Settings-editable), and use it to exclude known-foreign non-remote roles from deep-scoring (saving tokens) while ranking them low via a penalized heuristic score.

**Architecture:** (1) Ashby connector prefers `workplaceType` over `isRemote` so Hybrid→`false`. (2) A `homeCountry` setting + `resolveHomeCountry`, pre-filled from the resume via `parseCountry`. (3) `resolvePostingCountry` + `isOffCountryNonStarter` predicate mirroring `resolvePostingRemote`. (4) `score-run.ts` gains a second, independent partition that routes off-country non-starters to the existing penalized-heuristic path with a new `heuristic-location-penalized` tag.

**Tech Stack:** TypeScript-strict ESM, `better-sqlite3`, zod, vitest (colocated, offline).

## Global Constraints

- TypeScript-strict, ESM. No type assertions; NEVER the `!` non-null assertion.
- No new dependencies.
- **Never guess/drop unknowns.** Unknown-country and remote roles are always kept (deep-scored).
- Exclusion rule: exclude ONLY roles with a KNOWN country ≠ homeCountry AND not remote.
- `homeCountry` blank/unset ⇒ feature is a no-op (no filtering, no penalty).
- Country/remote gates compose independently; a role failing either is penalized ONCE. The remote tag takes precedence when both apply (the remote-only filter partitions first; the off-country gate derives from remote-survivors, so it can't re-tag a role the remote gate already excluded).
- `resolveHomeCountry` canonicalizes the stored value through `parseCountry` so free-text Settings entries ("United States"/"USA"/"us") normalize to the canonical label ("US") before the `===` country comparison.
- Ashby `workplaceType` values (confirmed live): `"OnSite"` | `"Remote"` | `"Hybrid"`. `remote = workplaceType === "Remote"`.
- Reuse `applyRemotePenalty` (factor `REMOTE_PENALTY_FACTOR = 0.6`) for the location penalty — no new constant.
- Biome: 2-space indent, 100-col, double quotes. Run `./node_modules/.bin/biome check .` before commit.
- Coverage gate: statements 93 / branches 85 / functions 90 / lines 93. Web: `npm run test:web`.
- Conventional Commits. NO Claude co-authored footer.

## File Structure

- `src/discovery/connectors/schemas.ts` — `AshbyJob` gains `workplaceType`.
- `src/discovery/connectors/ashby.ts` — `ashbyRemote(workplaceType, isRemote)` helper.
- `src/discovery/connectors/__fixtures__/ashby.json` — refreshed with a hybrid job.
- `src/matching/location-filter.ts` — `resolvePostingCountry`, `isOffCountryNonStarter`.
- `src/matching/settings-keys.ts` + `resolve-settings.ts` — `HOME_COUNTRY_SETTING`, `resolveHomeCountry`.
- `src/profile/build-profile.ts` (+ its callers) — detect country, store setting when unset.
- `src/storage/repository.ts` — `ScorerTag` gains `heuristic-location-penalized`.
- `src/matching/score-run.ts` — second partition + penalty for off-country non-starters.
- `src/matching/score-runner.ts` (server) — resolve `homeCountry` into `ScoreOptions`.
- `web/src/api.ts` + `web/src/views/Settings.tsx` — Home country field.

---

### Task 1: Fix Ashby Hybrid→Remote mis-flag

**Files:**
- Modify: `src/discovery/connectors/schemas.ts:38-46`, `src/discovery/connectors/ashby.ts`
- Modify: `src/discovery/connectors/__fixtures__/ashby.json` (add a hybrid job)
- Test: `src/discovery/connectors/ashby.test.ts` (extend the "remote field" describe)

**Interfaces:**
- Produces: `ashbyRemote(workplaceType: string | undefined, isRemote: boolean | undefined): boolean | undefined` — `workplaceType === "Remote"` when workplaceType present; else `isRemote`; `undefined` when both absent.

- [ ] **Step 1: Write failing tests for the hybrid mapping**

Append to the `describe("AshbyConnector — remote field")` block in `src/discovery/connectors/ashby.test.ts`:

```typescript
  it("maps workplaceType Hybrid to remote=false even when isRemote=true", async () => {
    const feed = {
      jobs: [
        {
          id: "ah1",
          title: "Hybrid Engineer",
          jobUrl: "https://jobs.ashbyhq.com/acme/ah1",
          descriptionPlain: "desc",
          location: "Austin, TX (Hybrid)",
          isRemote: true,
          workplaceType: "Hybrid",
        },
      ],
    };
    const fetcher = new FakeFetcher({
      [ENDPOINT]: { statusCode: 200, finalUrl: ENDPOINT, bodyText: JSON.stringify(feed) },
    });
    const result = await new AshbyConnector().fetchPostings("acme", fetcher);
    if (!result.ok) throw new Error("expected ok");
    expect(result.postings[0]?.remote).toBe(false);
  });

  it("maps workplaceType Remote to remote=true", async () => {
    const feed = {
      jobs: [
        {
          id: "ar2",
          title: "Remote Engineer",
          jobUrl: "https://jobs.ashbyhq.com/acme/ar2",
          descriptionPlain: "desc",
          location: "Remote",
          isRemote: true,
          workplaceType: "Remote",
        },
      ],
    };
    const fetcher = new FakeFetcher({
      [ENDPOINT]: { statusCode: 200, finalUrl: ENDPOINT, bodyText: JSON.stringify(feed) },
    });
    const result = await new AshbyConnector().fetchPostings("acme", fetcher);
    if (!result.ok) throw new Error("expected ok");
    expect(result.postings[0]?.remote).toBe(true);
  });

  it("maps workplaceType OnSite to remote=false", async () => {
    const feed = {
      jobs: [
        {
          id: "ao2",
          title: "Onsite Engineer",
          jobUrl: "https://jobs.ashbyhq.com/acme/ao2",
          descriptionPlain: "desc",
          location: "Austin, TX (On-site)",
          isRemote: false,
          workplaceType: "OnSite",
        },
      ],
    };
    const fetcher = new FakeFetcher({
      [ENDPOINT]: { statusCode: 200, finalUrl: ENDPOINT, bodyText: JSON.stringify(feed) },
    });
    const result = await new AshbyConnector().fetchPostings("acme", fetcher);
    if (!result.ok) throw new Error("expected ok");
    expect(result.postings[0]?.remote).toBe(false);
  });
```

The existing 3 remote-field tests (isRemote true/false/absent, no workplaceType) must keep passing — they exercise the fallback.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/discovery/connectors/ashby.test.ts -t "remote field"`
Expected: FAIL — the Hybrid case returns `remote: true` (current code passes `isRemote` straight through), so `expect(...).toBe(false)` fails.

- [ ] **Step 3: Add `workplaceType` to the Ashby schema**

In `src/discovery/connectors/schemas.ts`, add to `AshbyJob` (lines 38-46):

```typescript
const AshbyJob = z
  .object({
    title: z.string(),
    jobUrl: z.string(),
    descriptionPlain: z.string().optional(),
    location: z.string().optional(),
    isRemote: z.boolean().optional(),
    workplaceType: z.string().optional(),
  })
  .passthrough();
```

- [ ] **Step 4: Add `ashbyRemote` and use it in the connector**

In `src/discovery/connectors/ashby.ts`, add the helper and use it:

```typescript
/**
 * Ashby's `isRemote` is true for BOTH Remote and Hybrid location types, so it can't be trusted to
 * mean "fully remote". `workplaceType` ("Remote" | "Hybrid" | "OnSite") is authoritative when
 * present — a Hybrid role is NOT remote. Fall back to `isRemote` only when workplaceType is absent.
 */
export function ashbyRemote(
  workplaceType: string | undefined,
  isRemote: boolean | undefined,
): boolean | undefined {
  if (workplaceType !== undefined) return workplaceType === "Remote";
  return isRemote;
}
```

and change the `map` in `fetchPostings`:

```typescript
      map: (job) => ({
        title: job.title,
        url: job.jobUrl,
        description: job.descriptionPlain ?? "",
        location: job.location,
        remote: ashbyRemote(job.workplaceType, job.isRemote),
      }),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/discovery/connectors/ashby.test.ts`
Expected: PASS — Hybrid→false, Remote→true, OnSite→false, and the three fallback tests (no workplaceType) still pass.

- [ ] **Step 6: Refresh the committed fixture with a hybrid job**

Add a hybrid job to `src/discovery/connectors/__fixtures__/ashby.json` so the fixture reflects reality. Use this real example (from the SafeLease board); keep the existing two jobs and update the `toHaveLength(2)` assertion in the "maps a feed into normalized postings" test to `3`, and add an assertion that the hybrid job's `.remote` is `false`:

```json
{
  "title": "Data Analyst",
  "jobUrl": "https://jobs.ashbyhq.com/acme/hybrid-1",
  "descriptionPlain": "Hybrid role in Austin.",
  "location": "Austin, TX (Hybrid)",
  "isRemote": true,
  "workplaceType": "Hybrid"
}
```

In the "maps a feed into normalized postings" test, add after the existing assertions:

```typescript
    expect(result.postings).toHaveLength(3);
    const hybrid = result.postings.find((p) => p.title === "Data Analyst");
    expect(hybrid?.remote).toBe(false);
```

(Change the existing `toHaveLength(2)` to `3`.)

- [ ] **Step 7: Run the connector suite + lint**

Run: `npx vitest run src/discovery/connectors/ && ./node_modules/.bin/biome check src/discovery/connectors/`
Expected: pass, no lint errors.

- [ ] **Step 8: Commit**

```bash
git add src/discovery/connectors/ashby.ts src/discovery/connectors/schemas.ts src/discovery/connectors/ashby.test.ts src/discovery/connectors/__fixtures__/ashby.json
git commit -m "fix(ashby): treat Hybrid as non-remote via workplaceType, not isRemote"
```

---

### Task 2: `resolvePostingCountry` + `isOffCountryNonStarter`

**Files:**
- Modify: `src/matching/location-filter.ts` (add two exports)
- Test: `src/matching/location-filter.test.ts`

**Interfaces:**
- Consumes: `parseCountry` (same file), `resolvePostingRemote` (`@app/matching/remote-filter`).
- Produces:
  - `resolvePostingCountry(posting: Pick<JobPosting, "country" | "location">): string | undefined`
  - `isOffCountryNonStarter(posting: Pick<JobPosting, "country" | "location" | "remote">, homeCountry: string | undefined): boolean`

- [ ] **Step 1: Write the failing tests**

Add a new describe to `src/matching/location-filter.test.ts`:

```typescript
import { isOffCountryNonStarter, resolvePostingCountry } from "./location-filter";

describe("resolvePostingCountry", () => {
  it("prefers the structured country over the parsed location", () => {
    expect(resolvePostingCountry({ country: "UK", location: "Austin, Texas" })).toBe("UK");
  });
  it("falls back to parsing the location when no structured country", () => {
    expect(resolvePostingCountry({ location: "Austin, Texas" })).toBe("US");
  });
  it("returns undefined for an unparseable location", () => {
    expect(resolvePostingCountry({ location: "San Francisco" })).toBeUndefined();
  });
});

describe("isOffCountryNonStarter", () => {
  const home = "US";
  it("false when no home country is set", () => {
    expect(isOffCountryNonStarter({ country: "UK", location: "London", remote: false }, undefined)).toBe(false);
  });
  it("false for an in-country on-site role", () => {
    expect(isOffCountryNonStarter({ country: "US", location: "Austin", remote: false }, home)).toBe(false);
  });
  it("true for a known-foreign on-site role", () => {
    expect(isOffCountryNonStarter({ country: "UK", location: "London", remote: false }, home)).toBe(true);
  });
  it("false for a foreign REMOTE role (remote is kept)", () => {
    expect(isOffCountryNonStarter({ country: "UK", location: "London", remote: true }, home)).toBe(false);
  });
  it("false for an unknown-country role (never dropped)", () => {
    expect(isOffCountryNonStarter({ location: "San Francisco", remote: false }, home)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/matching/location-filter.test.ts -t "isOffCountryNonStarter"`
Expected: FAIL — the functions don't exist (import error / not a function).

- [ ] **Step 3: Implement the two functions**

In `src/matching/location-filter.ts`, add at the top the import and at the bottom the exports:

```typescript
import type { JobPosting } from "@app/domain/types";
import { resolvePostingRemote } from "./remote-filter";
```

```typescript
/** The posting's country: the structured field when present, else parsed from its location text. */
export function resolvePostingCountry(
  posting: Pick<JobPosting, "country" | "location">,
): string | undefined {
  if (posting.country !== undefined) return posting.country;
  return parseCountry(posting.location);
}

/**
 * Whether a posting is a clear off-country non-starter given the user's home country: it has a
 * KNOWN country different from home AND is not remote. Unknown-country and remote roles are never
 * non-starters (never guessed away). Returns false when no home country is set (feature off).
 */
export function isOffCountryNonStarter(
  posting: Pick<JobPosting, "country" | "location" | "remote">,
  homeCountry: string | undefined,
): boolean {
  if (homeCountry === undefined || homeCountry.trim() === "") return false;
  const country = resolvePostingCountry(posting);
  if (country === undefined) return false; // unknown → keep
  if (country === homeCountry) return false; // in-country → keep
  return !resolvePostingRemote(posting); // foreign: non-starter only if not remote
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/matching/location-filter.test.ts`
Expected: PASS — including the existing `parseCountry` cases (unchanged).

- [ ] **Step 5: Lint + commit**

Run: `./node_modules/.bin/biome check src/matching/location-filter.ts`
```bash
git add src/matching/location-filter.ts src/matching/location-filter.test.ts
git commit -m "feat(location): resolvePostingCountry and isOffCountryNonStarter predicate"
```

---

### Task 3: `homeCountry` setting + resolver

**Files:**
- Modify: `src/matching/settings-keys.ts`, `src/matching/resolve-settings.ts`
- Test: `src/matching/resolve-settings.test.ts`

**Interfaces:**
- Produces: `HOME_COUNTRY_SETTING = "homeCountry"`; `resolveHomeCountry(settings: SettingsReader): string | undefined`.

- [ ] **Step 1: Write the failing test**

Add to `src/matching/resolve-settings.test.ts`:

```typescript
describe("resolveHomeCountry", () => {
  it("returns undefined when unset", () => {
    expect(resolveHomeCountry(reader({}))).toBeUndefined();
  });
  it("returns the trimmed stored value", () => {
    expect(resolveHomeCountry(reader({ homeCountry: " US " }))).toBe("US");
  });
  it("returns undefined for a blank value", () => {
    expect(resolveHomeCountry(reader({ homeCountry: "   " }))).toBeUndefined();
  });
});
```

(Use the file's existing `reader(...)` helper; import `resolveHomeCountry`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/matching/resolve-settings.test.ts -t "resolveHomeCountry"`
Expected: FAIL — function doesn't exist.

- [ ] **Step 3: Add the key and resolver**

In `src/matching/settings-keys.ts`:

```typescript
export const HOME_COUNTRY_SETTING = "homeCountry";
```

In `src/matching/resolve-settings.ts` (near `resolveScorerModel`), add the import and:

```typescript
import { HOME_COUNTRY_SETTING } from "./settings-keys";

/** The user's home country label (e.g. "US"), or undefined when unset/blank (feature off). */
export function resolveHomeCountry(settings: SettingsReader): string | undefined {
  const value = settings.getSetting(HOME_COUNTRY_SETTING)?.trim();
  return value ? value : undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/matching/resolve-settings.test.ts -t "resolveHomeCountry"`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

Run: `./node_modules/.bin/biome check src/matching/`
```bash
git add src/matching/settings-keys.ts src/matching/resolve-settings.ts src/matching/resolve-settings.test.ts
git commit -m "feat(settings): homeCountry setting + resolveHomeCountry"
```

---

### Task 4: Detect home country from the resume

**Files:**
- Modify: `src/profile/build-profile.ts` and/or its callers (CLI `profile` command in `src/cli/main.ts`; server resume-upload path in `src/server/app.ts`)
- Test: whichever unit owns the detection (a new `detectHomeCountry` unit is easiest to test in isolation)

**Interfaces:**
- Consumes: `parseCountry` (`@app/matching/location-filter`), `HOME_COUNTRY_SETTING`.
- Produces: on resume ingest, when `homeCountry` is unset, store `parseCountry(resumeText)` if it resolves; never overwrite an existing value.

- [ ] **Step 1: Decide the seam and write the failing test**

Read `src/profile/build-profile.ts` and both callers to find where the resume text + repo are both in scope at ingest time. The cleanest testable unit is a small pure helper:

```typescript
// detectHomeCountry: returns the country to store, or undefined to leave the setting alone.
export function detectHomeCountry(resumeText: string, currentHomeCountry: string | undefined): string | undefined {
  if (currentHomeCountry !== undefined && currentHomeCountry.trim() !== "") return undefined; // never overwrite
  return parseCountry(resumeText);
}
```

Write its test (new file `src/profile/detect-home-country.test.ts` or colocated):

```typescript
describe("detectHomeCountry", () => {
  it("returns the parsed country when none is set", () => {
    expect(detectHomeCountry("123 Main St, Austin, Texas 78701", undefined)).toBe("US");
  });
  it("returns undefined (no change) when a country is already set", () => {
    expect(detectHomeCountry("123 Main St, Austin, Texas", "UK")).toBeUndefined();
  });
  it("returns undefined when the resume has no parseable country", () => {
    expect(detectHomeCountry("Software engineer, remote", undefined)).toBeUndefined();
  });
});
```

NOTE: `parseCountry` scans location-style tokens; a full resume is prose, so detection is best-effort (an address line like "Austin, Texas" resolves; freeform prose may not). This is acceptable — undetected leaves the setting blank for the user to fill.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/profile/ -t "detectHomeCountry"`
Expected: FAIL — function doesn't exist.

- [ ] **Step 3: Implement `detectHomeCountry` and wire it at ingest**

Create the helper (in `src/profile/detect-home-country.ts` or inside `build-profile.ts`). Then, in BOTH resume-ingest paths (CLI `profile` handler in `main.ts`; server upload handler in `app.ts`), after saving the profile, do:

```typescript
const detected = detectHomeCountry(resumeText, resolveHomeCountry(settings));
if (detected !== undefined) repo.setSetting(HOME_COUNTRY_SETTING, detected);
```

(Use the repo's existing `setSetting` and `resolveHomeCountry`. Confirm `resumeText` is in scope at each call site — it's read via `readResumeText` before `buildProfile`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/profile/`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint + commit**

Run: `npm run typecheck && ./node_modules/.bin/biome check src/profile/ src/cli/main.ts src/server/app.ts`
```bash
git add src/profile/ src/cli/main.ts src/server/app.ts
git commit -m "feat(profile): pre-fill homeCountry from the resume when unset"
```

---

### Task 5: `heuristic-location-penalized` scorer tag

**Files:**
- Modify: `src/storage/repository.ts:40` (`ScorerTag` union), `:64-66` (`normalizeScorerTag`)
- Test: `src/storage/repository.test.ts`

**Interfaces:**
- Produces: `ScorerTag` includes `"heuristic-location-penalized"`; `normalizeScorerTag` round-trips it.

- [ ] **Step 1: Write the failing test**

Add to `src/storage/repository.test.ts` a test that saves a match with the new tag and reads it back:

```typescript
it("round-trips the heuristic-location-penalized scorer tag", () => {
  const repo = newRepo();
  // seed a posting (use the file's existing helper to insert one), then:
  repo.saveMatchResult("some-posting-id", { score: 40, matchedSkills: [], missingSkills: [] }, "heuristic-location-penalized");
  const scored = repo.listScoredPostings();
  const row = scored.find((s) => s.posting.id === "some-posting-id");
  expect(row?.scorer).toBe("heuristic-location-penalized");
});
```

(Match the file's helper for inserting a posting so `saveMatchResult` has a row to attach to — see how existing `saveMatchResult` tests seed a posting.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/storage/repository.test.ts -t "heuristic-location-penalized"`
Expected: FAIL — TypeScript rejects the tag (not in the union), or `normalizeScorerTag` maps it to `heuristic`.

- [ ] **Step 3: Extend the union and normalizer**

In `src/storage/repository.ts`, line 40:

```typescript
export type ScorerTag =
  | "heuristic"
  | "llm"
  | "heuristic-remote-penalized"
  | "heuristic-location-penalized";
```

In `normalizeScorerTag` (around line 64), add:

```typescript
  if (scorer === "heuristic-location-penalized") return "heuristic-location-penalized";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/storage/repository.test.ts -t "heuristic-location-penalized"`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

Run: `./node_modules/.bin/biome check src/storage/repository.ts`
```bash
git add src/storage/repository.ts src/storage/repository.test.ts
git commit -m "feat(storage): heuristic-location-penalized scorer tag"
```

---

### Task 6: Off-country partition in `score-run.ts`

**Files:**
- Modify: `src/matching/score-run.ts` (`ScoreOptions` gains `homeCountry?`; add the partition + penalty)
- Test: `src/matching/score-run.test.ts`

**Interfaces:**
- Consumes: `isOffCountryNonStarter` (Task 2), `applyRemotePenalty` (existing), `"heuristic-location-penalized"` (Task 5).
- Produces: `ScoreOptions` includes `homeCountry?: string`. Off-country non-starters are excluded from the LLM path and saved `heuristic-location-penalized` with a reduced score, idempotently, respecting the cap, composing with `remoteOnly`.

- [ ] **Step 1: Write the failing tests**

Add to `src/matching/score-run.test.ts` (use the file's existing fake-repo + candidate fixtures). Cover: (a) a foreign on-site candidate is NOT deep-scored and IS saved `heuristic-location-penalized` with score < original; (b) a foreign REMOTE candidate and an unknown-country candidate ARE deep-scored; (c) idempotent — a row already `heuristic-location-penalized` isn't re-penalized; (d) no `homeCountry` ⇒ unchanged behavior. Sketch one:

```typescript
it("excludes foreign on-site roles from the LLM and penalizes them", async () => {
  const candidates = [
    makeCandidate({ id: "us-remote", country: "US", remote: true, heuristic: 70 }),
    makeCandidate({ id: "uk-onsite", country: "UK", remote: false, heuristic: 80 }),
    makeCandidate({ id: "unknown", location: "San Francisco", remote: false, heuristic: 75 }),
  ];
  const repo = fakeScoreRepo(candidates);
  const saved: { id: string; scorer: string; score: number }[] = [];
  repo.saveMatchResult = (id, result, scorer) => saved.push({ id, scorer, score: result.score });

  const scorer = fakeScorer(); // records which postings reach the LLM
  await runScoreRun({
    repo, profile, triager: passThroughTriager, scorer,
    options: { minHeuristic: 0, limit: 50, remoteOnly: false, rescore: false, dryRun: false, batchSize: 10, cost, homeCountry: "US" },
  });

  // uk-onsite: penalized, not deep-scored
  const uk = saved.find((s) => s.id === "uk-onsite");
  expect(uk?.scorer).toBe("heuristic-location-penalized");
  expect(uk?.score).toBeLessThan(80);
  expect(scorer.scoredIds).not.toContain("uk-onsite");
  // us-remote and unknown reach the LLM
  expect(scorer.scoredIds).toEqual(expect.arrayContaining(["us-remote", "unknown"]));
});
```

(Match the file's actual candidate/repo/scorer fake helpers — read how the existing remoteOnly-penalty tests are written and mirror them; the remote-only partition tests are the direct analog.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/matching/score-run.test.ts -t "foreign on-site"`
Expected: FAIL — `homeCountry` isn't an option; uk-onsite is currently deep-scored, not penalized.

- [ ] **Step 3: Add `homeCountry` to `ScoreOptions`**

In `src/matching/score-run.ts`, extend the `ScoreOptions` type (around line 21):

```typescript
export type ScoreOptions = {
  minHeuristic: number;
  limit: number;
  remoteOnly: boolean;
  rescore: boolean;
  dryRun: boolean;
  batchSize: number;
  cost: { perTriageTitleUsd: number; perDeepScoreUsd: number };
  /** When set, known-foreign non-remote roles are excluded from the LLM and penalized. */
  homeCountry?: string;
};
```

- [ ] **Step 4: Add the off-country partition**

In `runScoreRun`, after the remote-only partition builds `afterRemote` / `nonRemotePenalized` (lines 94-100), add a second independent split on `afterRemote` (the roles that passed the remote gate). Import `isOffCountryNonStarter` and `applyRemotePenalty` (the latter already imported):

```typescript
import { applyRemotePenalty } from "./heuristic-scorer";
import { isOffCountryNonStarter } from "./location-filter";
```

After the remote partition:

```typescript
  // Second, independent gate: with a home country set, roles that are KNOWN-foreign and not remote
  // are non-starters — keep them out of the LLM (saves tokens) and penalize them like non-remote
  // roles. Composes with remoteOnly: this only inspects roles that already passed the remote gate.
  const offCountry = options.homeCountry
    ? afterRemote.filter((c) => isOffCountryNonStarter(c.posting, options.homeCountry))
    : [];
  const inCountryOrKept = options.homeCountry
    ? afterRemote.filter((c) => !isOffCountryNonStarter(c.posting, options.homeCountry))
    : afterRemote;
```

Then use `inCountryOrKept` in place of `afterRemote` for the not-yet-scored/cap/LLM path (the `notYetScored`/`eligible` computation), and add the off-country penalized writes alongside the existing `nonRemoteToPenalize` writes. Mirror the existing non-remote penalty block exactly, but tag `heuristic-location-penalized` and guard idempotency on that tag:

```typescript
  const offCountryToPenalize = offCountry
    .filter((c) => c.scorer !== "heuristic-location-penalized")
    .filter((c) => options.rescore || !c.alreadyLlmScored)
    .slice(0, options.limit);
```

And in the write phase (after the dry-run gate, next to the `nonRemoteToPenalize` loop):

```typescript
  for (const c of offCountryToPenalize) {
    repo.saveMatchResult(c.posting.id, applyRemotePenalty(c.current), "heuristic-location-penalized");
  }
```

Update the counts block: add the off-country penalized count to `remotePenalized` or a new `locationPenalized` count as the file's `ScoreStageCounts` allows (add a field if needed and surface it in the plan/preview). Ensure the LLM path (`eligible`) is computed from `inCountryOrKept`, so foreign on-site roles never reach triage/LLM.

DOUBLE-GATE PRECEDENCE: a role excluded by remote-only already went to `nonRemotePenalized` (never in `afterRemote`), so it can't also be in `offCountry` — no double penalty by construction. Verify this holds (offCountry is derived from `afterRemote`, which already excluded non-remote under remoteOnly).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/matching/score-run.test.ts`
Expected: PASS — foreign on-site excluded + penalized; foreign-remote and unknown deep-scored; idempotent; no-homeCountry unchanged; existing remote-only tests still green.

- [ ] **Step 6: Lint + full matching suite**

Run: `npx vitest run src/matching/ && ./node_modules/.bin/biome check src/matching/score-run.ts`
Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/matching/score-run.ts src/matching/score-run.test.ts
git commit -m "feat(score): exclude and penalize known-foreign on-site roles by home country"
```

---

### Task 7: Resolve `homeCountry` into the server score options

**Files:**
- Modify: `src/matching/score-runner.ts` (or wherever `ScoreOptions` is assembled for the server/CLI from settings) — resolve `homeCountry` from settings into the options.
- Test: the score-runner's test, or `app.test.ts` if options assembly is there.

**Interfaces:**
- Consumes: `resolveHomeCountry` (Task 3), `ScoreOptions.homeCountry` (Task 6).
- Produces: deep-score runs (CLI + server) pass the resolved `homeCountry` into `runScoreRun`.

- [ ] **Step 1: Locate where `ScoreOptions` is built from settings**

Read `src/matching/score-runner.ts` (and the CLI `score` wiring in `main.ts`) to find where `minHeuristic`/`cost`/`batchSize` are resolved from settings into `ScoreOptions`. `homeCountry` is resolved the same way (`resolveHomeCountry(settings)`).

- [ ] **Step 2: Write the failing test**

Add a test asserting that when the `homeCountry` setting is set, the assembled `ScoreOptions` passed to `runScoreRun` carries it (and is `undefined` when unset). Mirror how existing option-resolution is tested.

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run` on the relevant test file, `-t "homeCountry"`.
Expected: FAIL — options don't include homeCountry yet.

- [ ] **Step 4: Wire it in**

Where `ScoreOptions` is assembled from settings, add:

```typescript
    ...(resolveHomeCountry(settings) ? { homeCountry: resolveHomeCountry(settings) } : {}),
```

(Import `resolveHomeCountry`. Compute once into a local if biome flags the double call.)

- [ ] **Step 5: Run it to verify it passes + typecheck**

Run: `npm run typecheck && npx vitest run` on the file.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/matching/score-runner.ts src/cli/main.ts <test files>
git commit -m "feat(score): thread homeCountry from settings into deep-score options"
```

---

### Task 8: Home country in the Settings UI

**Files:**
- Modify: settings API (`src/server/app.ts` `SettingsView` + save path), `web/src/api.ts` (schema), `web/src/views/Settings.tsx`
- Test: `web/src/api.test.ts` (SettingsView drift), `src/server/app.test.ts` (round-trip)

**Interfaces:**
- Consumes: `HOME_COUNTRY_SETTING` (Task 3).
- Produces: `homeCountry` readable/writable via settings API; a "Home country" input in Settings.

- [ ] **Step 1: Inspect the settings API shape**

Read how `scorerModel` flows: `GET /api/settings` response builder + `SettingsView` in `app.ts`, the save/PATCH handler, and the `SettingsView` zod schema in `web/src/api.ts`. `homeCountry` mirrors it (a nullable string).

- [ ] **Step 2: Write the failing drift + round-trip tests**

In `web/src/api.test.ts`, extend the `SettingsView` fixture(s) with `homeCountry` (nullable string, matching how `scorerModel` is typed). In `src/server/app.test.ts`, add a test that PATCHing `homeCountry` then GETting settings returns it. Run both; confirm they fail.

- [ ] **Step 3: Expose the setting in the API**

Add `homeCountry` to the `SettingsView` builder in `app.ts` (read from `HOME_COUNTRY_SETTING`), the zod schema in `web/src/api.ts`, and the settings-save handler (accept + persist it), mirroring `scorerModel`.

- [ ] **Step 4: Add the Settings input**

In `web/src/views/Settings.tsx`, add a "Home country" text input (mirror the scorer-model field) bound to the setting, with a hint: "Your country (e.g. US). Foreign on-site roles are ranked lower and skipped when deep-scoring. Auto-filled from your resume when possible."

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:web && npx vitest run src/server/app.test.ts`
Expected: PASS (drift test green).

- [ ] **Step 6: Typechecks + lint + commit**

Run: `npm run typecheck && npm run typecheck:web && ./node_modules/.bin/biome check .`
```bash
git add src/server/app.ts src/server/app.test.ts web/src/api.ts web/src/api.test.ts web/src/views/Settings.tsx
git commit -m "feat(settings): Home country field in the settings API + dashboard"
```

---

### Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full CI parity**

Run: `./node_modules/.bin/biome check . && npm run typecheck && npm run typecheck:web && npm run test:coverage && npm run test:web && npm run build:web`
Expected: lint clean, both typechecks clean, coverage ≥ 93/85/90/93, web tests pass, build clean.

- [ ] **Step 2: Confirm the token-saving end to end**

Verify (via a `score-run` preview test or the counts) that with a `homeCountry` set and foreign on-site roles present, the deep-score plan's triage/deep-score counts DROP versus no home country — proving fewer tokens are spent. If not already asserted in Task 6, add it here.

- [ ] **Step 3: Manual smoke (optional)**

`npm run cli -- serve` against a throwaway DB seeded with the SafeLease hybrid + a foreign on-site role; set Home country = US in Settings; run a deep-score preview and confirm foreign on-site roles are excluded and the hybrid is no longer badged Remote.

# Split Scan/Score Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single `scan` command into a free `scan` (discover + heuristic-score) and a paid `score` (heuristic-gated batch LLM triage → deep score), bounded by `--min-heuristic` + `--limit` with a `--dry-run` cost preview, plus a saved `remote_only` filter that excludes non-remote roles from the LLM stages.

**Architecture:** `scan` becomes today's `runScan` with a `HeuristicScorer` injected (no LLM). A new `score` command operates on postings already in the DB through a new pure orchestrator `score-run.ts` (remote filter → heuristic gate → cap → batch title-triage → deep score). A new `LlmTriager` (sibling to `LlmScorer`) does the batch keep/drop. A `scorer` column on `match_results` tracks whether a row is heuristic- or LLM-scored, making re-runs cheap.

**Tech Stack:** TypeScript (strict, ESM), better-sqlite3, zod, `@anthropic-ai/sdk`, vitest, Biome. Import server/CLI code via the `@app/*` alias.

## Global Constraints

- **TypeScript-strict, ESM**, target ES2022, `moduleResolution: bundler`. `noUncheckedIndexedAccess` and `noImplicitOverride` on.
- **No type assertions** except in tests. **Never** the `!` non-null assertion.
- **Strong typing** everywhere; prefer existing deps/custom functions over new dependencies.
- **Biome**: 2-space indent, 100-col width, double quotes. Run `npm run lint:fix` before committing.
- **Tests colocated** (`*.test.ts` next to source), offline, dependency-injected with fixtures. Do not hard-code values in `expect` — derive from inputs.
- **Coverage gate** (vitest.config.ts): statements 93 / branches 85 / functions 90 / lines 93. Keep green.
- **Failures degrade, never crash.** Discovery and scoring collect `Warning`s and return partial results.
- **Commits:** Conventional Commits. Do NOT add a Claude co-authored footer.
- **JS Date objects**, not Moment. Comments clarify non-obvious things only.
- Verify each task with `npm run lint && npm run typecheck && npm test` before committing.

---

### Task 1: Add `scorer` column + `saveMatchResult` tag + `listPostingsForScoring`

**Files:**
- Modify: `src/storage/repository.ts` (migrate, saveMatchResult, new listPostingsForScoring)
- Modify: `src/storage/repository.test.ts` (find the existing test file)
- Test: `src/storage/repository.test.ts`

**Interfaces:**
- Consumes: existing `Repository`, `JobPosting`, `MatchResult`.
- Produces:
  - `Repository.saveMatchResult(postingId: string, result: MatchResult, scorer?: "heuristic" | "llm"): void` — `scorer` defaults to `"heuristic"`.
  - `type ScoringCandidate = { posting: JobPosting; heuristicScore: number; alreadyLlmScored: boolean }`
  - `Repository.listPostingsForScoring(opts: { minHeuristic: number }): ScoringCandidate[]` — non-expired postings that HAVE a `match_results` row with `score >= minHeuristic`, each tagged with whether its row was written by the LLM (`scorer = 'llm'`), ordered by score desc then title.
  - `Repository.countLivePostings(): number` — count of non-expired postings (`SELECT COUNT(*) FROM postings WHERE expired_at IS NULL`). Drives the dry-run's true "In DB" total.

- [ ] **Step 1: Find the repository test file and the match_results assertions**

Run: `grep -n "saveMatchResult\|match_results\|scorer" src/storage/repository.test.ts`
Expected: locate existing `saveMatchResult` tests to extend. If no test file exists, create `src/storage/repository.test.ts` using the existing test setup pattern from another `*.test.ts` in `src/storage/`.

- [ ] **Step 2: Write the failing test for the `scorer` column + `listPostingsForScoring`**

Add to `src/storage/repository.test.ts` (adapt the in-memory DB setup to match the existing tests — they construct `new Repository(":memory:")` or a temp file):

```ts
import { describe, expect, it } from "vitest";
import type { JobPosting } from "@app/domain/types";
import { Repository } from "./repository";

function makePosting(id: string, title: string): JobPosting {
  return {
    id,
    company: "acme",
    title,
    url: `https://example.test/${id}`,
    source: "test",
    description: "desc",
    fetchedAt: new Date("2026-06-26T00:00:00Z"),
  };
}

describe("scorer tagging + listPostingsForScoring", () => {
  it("tags rows by scorer and lists candidates above the heuristic floor, score desc", () => {
    const repo = new Repository(":memory:");
    const low = makePosting("low", "Sales Rep");
    const mid = makePosting("mid", "Backend Engineer");
    const high = makePosting("high", "Staff Engineer");
    for (const p of [low, mid, high]) repo.savePosting(p);

    repo.saveMatchResult(low.id, { score: 10, matchedSkills: [], missingSkills: [] });
    repo.saveMatchResult(mid.id, { score: 45, matchedSkills: [], missingSkills: [] });
    repo.saveMatchResult(high.id, { score: 80, matchedSkills: [], missingSkills: [] }, "llm");

    const candidates = repo.listPostingsForScoring({ minHeuristic: 30 });

    expect(candidates.map((c) => c.posting.id)).toEqual([high.id, mid.id]);
    const highCandidate = candidates.find((c) => c.posting.id === high.id);
    const midCandidate = candidates.find((c) => c.posting.id === mid.id);
    expect(highCandidate?.alreadyLlmScored).toBe(true);
    expect(midCandidate?.alreadyLlmScored).toBe(false);
    expect(highCandidate?.heuristicScore).toBe(80);
    repo.close();
  });

  it("excludes expired postings from scoring candidates", () => {
    const repo = new Repository(":memory:");
    const p = makePosting("p", "Backend Engineer");
    repo.savePosting(p);
    repo.saveMatchResult(p.id, { score: 60, matchedSkills: [], missingSkills: [] });
    repo.markPostingExpired(p.id);

    expect(repo.listPostingsForScoring({ minHeuristic: 30 })).toEqual([]);
    repo.close();
  });

  it("counts only non-expired postings", () => {
    const repo = new Repository(":memory:");
    const live = makePosting("live", "Backend Engineer");
    const gone = makePosting("gone", "Frontend Engineer");
    repo.savePosting(live);
    repo.savePosting(gone);
    repo.markPostingExpired(gone.id);

    expect(repo.countLivePostings()).toBe(1);
    repo.close();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/storage/repository.test.ts -t "scorer tagging"`
Expected: FAIL — `listPostingsForScoring` is not a function / `scorer` arg ignored.

- [ ] **Step 4: Add the `scorer` column in `migrate()`**

In `src/storage/repository.ts`, extend `migrate()`. It currently only inspects `postings`; add an inspection of `match_results`:

```ts
private migrate(): void {
  const postingColumns = new Set(
    (this.db.prepare("PRAGMA table_info(postings)").all() as { name: string }[]).map((c) => c.name),
  );
  if (!postingColumns.has("last_seen_scan")) {
    this.db.exec("ALTER TABLE postings ADD COLUMN last_seen_scan INTEGER");
  }
  if (!postingColumns.has("expired_at")) {
    this.db.exec("ALTER TABLE postings ADD COLUMN expired_at TEXT");
  }

  const matchColumns = new Set(
    (this.db.prepare("PRAGMA table_info(match_results)").all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  if (!matchColumns.has("scorer")) {
    this.db.exec("ALTER TABLE match_results ADD COLUMN scorer TEXT");
  }
}
```

- [ ] **Step 5: Tag `saveMatchResult` with the scorer**

Replace `saveMatchResult` so it writes `scorer` (defaulting to `"heuristic"`):

```ts
saveMatchResult(
  postingId: string,
  result: MatchResult,
  scorer: "heuristic" | "llm" = "heuristic",
): void {
  this.db
    .prepare(
      `INSERT INTO match_results (posting_id, score, matched_skills, missing_skills, rationale, scorer)
       VALUES (@postingId, @score, @matched, @missing, @rationale, @scorer)
       ON CONFLICT(posting_id) DO UPDATE SET
         score = excluded.score,
         matched_skills = excluded.matched_skills,
         missing_skills = excluded.missing_skills,
         rationale = excluded.rationale,
         scorer = excluded.scorer`,
    )
    .run({
      postingId,
      score: result.score,
      matched: JSON.stringify(result.matchedSkills),
      missing: JSON.stringify(result.missingSkills),
      rationale: result.rationale ?? null,
      scorer,
    });
}
```

- [ ] **Step 6: Add `ScoringCandidate` type and `listPostingsForScoring`**

Add near the other exported types at the top of `repository.ts`:

```ts
/** A posting eligible for LLM scoring: its heuristic score plus whether the LLM already scored it. */
export type ScoringCandidate = {
  posting: JobPosting;
  heuristicScore: number;
  alreadyLlmScored: boolean;
};
```

Add the method to the `Repository` class (mirror the row→JobPosting mapping used by `listLivePostingsNotSeen`):

```ts
/**
 * Non-expired postings whose heuristic score meets `minHeuristic`, ranked score-desc then title,
 * each tagged with whether its match row was written by the LLM. Drives the `score` command's
 * candidate gating; expired postings are never re-scored.
 */
listPostingsForScoring(opts: { minHeuristic: number }): ScoringCandidate[] {
  const rows = this.db
    .prepare(
      `SELECT p.id, p.company, p.title, p.url, p.source, p.description, p.location,
              p.posted_at, p.fetched_at, m.score, m.scorer
       FROM match_results m
       JOIN postings p ON p.id = m.posting_id
       WHERE p.expired_at IS NULL AND m.score >= ?
       ORDER BY m.score DESC, p.title`,
    )
    .all(opts.minHeuristic) as {
    id: string;
    company: string;
    title: string;
    url: string;
    source: string;
    description: string;
    location: string | null;
    posted_at: string | null;
    fetched_at: string;
    score: number;
    scorer: string | null;
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
      ...(row.posted_at ? { postedAt: new Date(row.posted_at) } : {}),
      fetchedAt: new Date(row.fetched_at),
    },
    heuristicScore: row.score,
    alreadyLlmScored: row.scorer === "llm",
  }));
}

/** Count of non-expired postings — the dry-run's "In DB" total before any filtering. */
countLivePostings(): number {
  const row = this.db
    .prepare("SELECT COUNT(*) AS n FROM postings WHERE expired_at IS NULL")
    .get() as { n: number };
  return row.n;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/storage/repository.test.ts`
Expected: PASS (all repository tests, including the new ones).

- [ ] **Step 8: Lint, typecheck, commit**

```bash
npm run lint:fix
npm run typecheck
git add src/storage/repository.ts src/storage/repository.test.ts
git commit -m "feat(storage): tag match results by scorer and add scoring-candidate query"
```

---

### Task 2: Remote filter (`isRemote`)

**Files:**
- Create: `src/matching/remote-filter.ts`
- Test: `src/matching/remote-filter.test.ts`

**Interfaces:**
- Produces: `isRemote(location?: string): boolean` — `true` when the free-text location reads as remote OR when location is undefined/empty (unknown is kept). `false` only when a non-empty location has no remote signal.

- [ ] **Step 1: Write the failing test**

Create `src/matching/remote-filter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isRemote } from "./remote-filter";

describe("isRemote", () => {
  const remoteStrings = [
    "Remote",
    "REMOTE",
    "Remote - US",
    "Remote - Worldwide",
    "Remote (United States)",
    "Remote in Canada in EST timezone",
    "Anywhere",
    "Distributed team",
    "Work from home",
    "WFH",
  ];
  for (const location of remoteStrings) {
    it(`treats "${location}" as remote`, () => {
      expect(isRemote(location)).toBe(true);
    });
  }

  const onsiteStrings = ["London, UK", "New York, NY", "San Francisco, CA"];
  for (const location of onsiteStrings) {
    it(`treats "${location}" as not remote`, () => {
      expect(isRemote(location)).toBe(false);
    });
  }

  it("keeps postings with an unknown location (undefined)", () => {
    expect(isRemote(undefined)).toBe(true);
  });

  it("keeps postings with an empty location string", () => {
    expect(isRemote("")).toBe(true);
    expect(isRemote("   ")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/matching/remote-filter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/matching/remote-filter.ts`:

```ts
/**
 * Whether a posting's free-text location reads as remote-eligible. Connectors emit wildly varying
 * strings ("Remote - US", "Remote (United States)", "Anywhere"), so this is a generous regex over
 * the field. An unknown location (undefined / blank) is treated as remote so a missing field never
 * silently drops a posting from the remote-only flow.
 */
const REMOTE_SIGNAL = /\b(remote|anywhere|distributed|work from home|wfh)\b/i;

export function isRemote(location?: string): boolean {
  if (location === undefined || location.trim() === "") return true;
  return REMOTE_SIGNAL.test(location);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/matching/remote-filter.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npm run lint:fix
npm run typecheck
git add src/matching/remote-filter.ts src/matching/remote-filter.test.ts
git commit -m "feat(matching): add remote-location filter"
```

---

### Task 3: Triage schema, prompt, and client seam

**Files:**
- Create: `src/matching/triage-schema.ts`
- Create: `src/matching/triage-prompt.ts`
- Create: `src/matching/triage-client.ts`
- Test: `src/matching/triage-prompt.test.ts`

**Interfaces:**
- Consumes: `SkillProfile` (`@app/domain/types`).
- Produces:
  - `TriageDecisionSchema` / `TriagePayloadSchema` (zod) and `type LlmTriagePayload = { decisions: { id: string; keep: boolean; reason: string }[] }`.
  - `type TriageItem = { id: string; title: string; location?: string }`.
  - `type LlmTriageRequest = { system: string; user: string }`.
  - `buildTriagePrompt(profile: SkillProfile, items: TriageItem[]): LlmTriageRequest`.
  - `interface TriageClient { triage(request: LlmTriageRequest): Promise<LlmTriagePayload> }`.
  - `class AnthropicTriageClient implements TriageClient` (production; smoke-only).
  - `class FakeTriageClient implements TriageClient` (test double; accepts a payload, a function of the request, or an `Error`).

- [ ] **Step 1: Write the failing test for the prompt builder**

Create `src/matching/triage-prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SkillProfile } from "@app/domain/types";
import { buildTriagePrompt, type TriageItem } from "./triage-prompt";

const profile: SkillProfile = {
  skills: ["typescript", "node"],
  roleKeywords: ["backend", "engineer"],
  categories: ["backend"],
};

describe("buildTriagePrompt", () => {
  it("puts the profile in the cacheable system prefix", () => {
    const { system } = buildTriagePrompt(profile, []);
    for (const skill of profile.skills) {
      expect(system).toContain(skill);
    }
  });

  it("lists every item id and title in the user message", () => {
    const items: TriageItem[] = [
      { id: "a", title: "Backend Engineer", location: "Remote" },
      { id: "b", title: "Sales Rep" },
    ];
    const { user } = buildTriagePrompt(profile, items);
    for (const item of items) {
      expect(user).toContain(item.id);
      expect(user).toContain(item.title);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/matching/triage-prompt.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the triage schema**

Create `src/matching/triage-schema.ts`:

```ts
import { z } from "zod";

/**
 * One keep/drop verdict per title in a triage batch. `.strict()` disallows unknown keys (also
 * satisfies the structured-output requirement that objects set `additionalProperties: false`).
 */
export const TriageDecisionSchema = z
  .object({
    id: z.string(),
    keep: z.boolean(),
    reason: z.string(),
  })
  .strict();

export const TriagePayloadSchema = z
  .object({
    decisions: z.array(TriageDecisionSchema),
  })
  .strict();

export type LlmTriagePayload = z.infer<typeof TriagePayloadSchema>;
```

- [ ] **Step 4: Write the triage prompt builder**

Create `src/matching/triage-prompt.ts`:

```ts
import type { SkillProfile } from "@app/domain/types";

export type TriageItem = { id: string; title: string; location?: string };

export type LlmTriageRequest = {
  /** Stable, cacheable prefix: triage instructions + the serialized profile. */
  system: string;
  /** Volatile per-batch content: the candidate titles. */
  user: string;
};

const INSTRUCTIONS = `You triage job titles for a job-search tool to decide which deserve a full, expensive review.

Given the candidate's skill profile (below) and a batch of job titles (in the user message), return one decision per title:
- id: the title's id, copied exactly from the input.
- keep: true if the role is plausibly worth a full review, false for a clear mismatch.
- reason: a short phrase explaining the decision.

Keep generously: equivalent technologies, adjacent roles, and plausible seniority matches should be kept. Drop only clear mismatches — wrong domain (e.g. sales, marketing, recruiting for an engineer), wrong discipline, or obviously wrong seniority. Return a decision for every id, and only ids present in the input.`;

function serializeProfile(profile: SkillProfile): string {
  const lines = [
    `Skills: ${profile.skills.join(", ") || "(none listed)"}`,
    `Role keywords: ${profile.roleKeywords.join(", ") || "(none listed)"}`,
    `Categories: ${profile.categories.join(", ") || "(none listed)"}`,
  ];
  if (profile.yearsExperience !== undefined) {
    lines.push(`Years of experience: ${profile.yearsExperience}`);
  }
  return lines.join("\n");
}

function serializeItem(item: TriageItem): string {
  const location = item.location ? ` [${item.location}]` : "";
  return `- id=${item.id} :: ${item.title}${location}`;
}

/**
 * Build the `{ system, user }` triage request. The profile + instructions form the cacheable
 * system prefix (byte-identical across batches in a run); the titles are the volatile user turn.
 */
export function buildTriagePrompt(profile: SkillProfile, items: TriageItem[]): LlmTriageRequest {
  return {
    system: `${INSTRUCTIONS}\n\n## Candidate profile\n${serializeProfile(profile)}`,
    user: `## Titles to triage\n${items.map(serializeItem).join("\n")}`,
  };
}
```

- [ ] **Step 5: Write the triage client seam**

Create `src/matching/triage-client.ts` (mirror `llm-client.ts`):

```ts
import { Anthropic } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { LlmTriageRequest } from "./triage-prompt";
import { type LlmTriagePayload, TriagePayloadSchema } from "./triage-schema";

/**
 * The triage seam, mirroring `LlmClient`. Every unit that batch-triages titles takes a
 * `TriageClient` so the suite runs against canned payloads with no live network.
 * `AnthropicTriageClient` is the production default (smoke-only); `FakeTriageClient` backs tests.
 */
export interface TriageClient {
  triage(request: LlmTriageRequest): Promise<LlmTriagePayload>;
}

const MAX_TOKENS = 4096;

/** Production `TriageClient` backed by the Anthropic Messages API. Smoke-tested only. */
export class AnthropicTriageClient implements TriageClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: { apiKey: string; model: string }) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
  }

  async triage(request: LlmTriageRequest): Promise<LlmTriagePayload> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: MAX_TOKENS,
      thinking: { type: "disabled" },
      output_config: {
        effort: "low",
        format: zodOutputFormat(TriagePayloadSchema),
      },
      system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: request.user }],
    });

    if (response.parsed_output === null) {
      throw new Error(`Triage returned no parseable output (stop_reason: ${response.stop_reason})`);
    }
    return response.parsed_output;
  }
}

/**
 * Test double. Construct with a payload (or a function of the request) to drive the success path,
 * or with an `Error` to simulate an API failure. No network.
 */
export class FakeTriageClient implements TriageClient {
  constructor(
    private readonly response:
      | LlmTriagePayload
      | ((request: LlmTriageRequest) => LlmTriagePayload)
      | Error,
  ) {}

  async triage(request: LlmTriageRequest): Promise<LlmTriagePayload> {
    if (this.response instanceof Error) throw this.response;
    return typeof this.response === "function" ? this.response(request) : this.response;
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/matching/triage-prompt.test.ts`
Expected: PASS.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
npm run lint:fix
npm run typecheck
git add src/matching/triage-schema.ts src/matching/triage-prompt.ts src/matching/triage-client.ts src/matching/triage-prompt.test.ts
git commit -m "feat(matching): add batch title-triage schema, prompt, and client seam"
```

---

### Task 4: `LlmTriager` (batch triage with fail-open degrade)

**Files:**
- Create: `src/matching/llm-triager.ts`
- Test: `src/matching/llm-triager.test.ts`

**Interfaces:**
- Consumes: `TriageClient`, `TriageItem`, `buildTriagePrompt`, `TriagePayloadSchema`, `SkillProfile`, `Warning`, `errorMessage` (`@app/net/error-message`).
- Produces:
  - `type TriageResult = { keptIds: Set<string> }`.
  - `class LlmTriager` with `constructor(client: TriageClient, batchSize: number, onWarning?: (w: Warning) => void)` and `async triage(profile: SkillProfile, items: TriageItem[]): Promise<TriageResult>` — splits items into batches of `batchSize`, calls the client per batch, and returns the union of kept ids. **Fail-open:** any batch that throws or returns a malformed/short payload keeps ALL of that batch's ids and emits a `Warning`. Never rejects.

- [ ] **Step 1: Write the failing tests**

Create `src/matching/llm-triager.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SkillProfile, Warning } from "@app/domain/types";
import { FakeTriageClient } from "./triage-client";
import { LlmTriager } from "./llm-triager";
import type { TriageItem } from "./triage-prompt";

const profile: SkillProfile = { skills: ["ts"], roleKeywords: [], categories: [] };

function items(n: number): TriageItem[] {
  return Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, title: `Title ${i}` }));
}

describe("LlmTriager", () => {
  it("returns the union of kept ids across batches", async () => {
    const all = items(3);
    const client = new FakeTriageClient((request) => ({
      decisions: all
        .filter((item) => request.user.includes(item.id))
        .map((item) => ({ id: item.id, keep: item.id !== "id-1", reason: "x" })),
    }));
    const triager = new LlmTriager(client, 2);

    const result = await triager.triage(profile, all);

    expect(result.keptIds.has("id-0")).toBe(true);
    expect(result.keptIds.has("id-1")).toBe(false);
    expect(result.keptIds.has("id-2")).toBe(true);
  });

  it("fail-opens a throwing batch: keeps all its ids and warns", async () => {
    const all = items(2);
    const client = new FakeTriageClient(new Error("api down"));
    const warnings: Warning[] = [];
    const triager = new LlmTriager(client, 10, (w) => warnings.push(w));

    const result = await triager.triage(profile, all);

    for (const item of all) expect(result.keptIds.has(item.id)).toBe(true);
    expect(warnings.length).toBe(1);
  });

  it("fail-opens a batch whose payload omits some ids", async () => {
    const all = items(2);
    // Only decides the first id; the second is missing from the payload.
    const client = new FakeTriageClient({
      decisions: [{ id: "id-0", keep: false, reason: "drop" }],
    });
    const warnings: Warning[] = [];
    const triager = new LlmTriager(client, 10, (w) => warnings.push(w));

    const result = await triager.triage(profile, all);

    // Fail-open on an incomplete batch keeps every id in the batch.
    expect(result.keptIds.has("id-0")).toBe(true);
    expect(result.keptIds.has("id-1")).toBe(true);
    expect(warnings.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/matching/llm-triager.test.ts`
Expected: FAIL — `LlmTriager` not found.

- [ ] **Step 3: Write the implementation**

Create `src/matching/llm-triager.ts`:

```ts
import type { SkillProfile, Warning } from "@app/domain/types";
import { errorMessage } from "@app/net/error-message";
import { type TriageItem, buildTriagePrompt } from "./triage-prompt";
import { type TriageClient } from "./triage-client";
import { TriagePayloadSchema } from "./triage-schema";

const WARNING_SOURCE = "llm-triager";

export type TriageResult = { keptIds: Set<string> };

/**
 * Batch keep/drop over job titles, backed by a `TriageClient`. Splits items into batches and
 * unions the kept ids. Fail-open: any batch that throws or returns a malformed / incomplete
 * payload keeps ALL of that batch's ids and emits a `Warning` — better to over-score a batch than
 * silently drop real matches. `triage` never rejects.
 */
export class LlmTriager {
  constructor(
    private readonly client: TriageClient,
    private readonly batchSize: number,
    private readonly onWarning?: (warning: Warning) => void,
  ) {}

  async triage(profile: SkillProfile, items: TriageItem[]): Promise<TriageResult> {
    const keptIds = new Set<string>();
    for (let start = 0; start < items.length; start += this.batchSize) {
      const batch = items.slice(start, start + this.batchSize);
      for (const id of await this.triageBatch(profile, batch)) keptIds.add(id);
    }
    return { keptIds };
  }

  /** Kept ids for a single batch; fail-opens (returns every id) on any error or incomplete result. */
  private async triageBatch(profile: SkillProfile, batch: TriageItem[]): Promise<string[]> {
    const batchIds = batch.map((item) => item.id);
    try {
      const payload = await this.client.triage(buildTriagePrompt(profile, batch));
      const parsed = TriagePayloadSchema.safeParse(payload);
      if (!parsed.success) return this.failOpen(batchIds, "triage returned a malformed payload");

      const decided = new Map(parsed.data.decisions.map((d) => [d.id, d.keep]));
      // Every id must have a decision; an incomplete batch is treated as a failure (fail-open).
      if (batchIds.some((id) => !decided.has(id))) {
        return this.failOpen(batchIds, "triage omitted some titles");
      }
      return batchIds.filter((id) => decided.get(id) === true);
    } catch (error) {
      return this.failOpen(batchIds, `triage failed: ${errorMessage(error)}`);
    }
  }

  private failOpen(batchIds: string[], message: string): string[] {
    this.onWarning?.({ source: WARNING_SOURCE, message: `${message}; keeping the batch` });
    return batchIds;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/matching/llm-triager.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npm run lint:fix
npm run typecheck
git add src/matching/llm-triager.ts src/matching/llm-triager.test.ts
git commit -m "feat(matching): add fail-open batch title triager"
```

---

### Task 5: Cost constants + estimator

**Files:**
- Modify: `src/matching/llm-providers.ts` (add per-provider cost constants)
- Create: `src/matching/cost-estimate.ts`
- Test: `src/matching/cost-estimate.test.ts`

**Interfaces:**
- Consumes: `LlmProviderConfig`.
- Produces:
  - On `LlmProviderConfig`: `cost: { perTriageTitleUsd: number; perDeepScoreUsd: number }` (added field).
  - `type CostEstimate = { triageTitles: number; triageBatches: number; deepScores: number; triageUsd: number; deepScoreUsd: number; totalUsd: number }`.
  - `estimateCost(opts: { triageTitles: number; deepScores: number; batchSize: number; cost: { perTriageTitleUsd: number; perDeepScoreUsd: number } }): CostEstimate`.

- [ ] **Step 1: Write the failing test**

Create `src/matching/cost-estimate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { estimateCost } from "./cost-estimate";

const cost = { perTriageTitleUsd: 0.002, perDeepScoreUsd: 0.03 };

describe("estimateCost", () => {
  it("counts batches by ceiling-dividing titles by batch size", () => {
    const estimate = estimateCost({ triageTitles: 82, deepScores: 82, batchSize: 40, cost });
    expect(estimate.triageBatches).toBe(Math.ceil(82 / 40));
  });

  it("derives each line and the total from the inputs and rates", () => {
    const triageTitles = 50;
    const deepScores = 30;
    const estimate = estimateCost({ triageTitles, deepScores, batchSize: 40, cost });

    expect(estimate.triageUsd).toBeCloseTo(triageTitles * cost.perTriageTitleUsd);
    expect(estimate.deepScoreUsd).toBeCloseTo(deepScores * cost.perDeepScoreUsd);
    expect(estimate.totalUsd).toBeCloseTo(estimate.triageUsd + estimate.deepScoreUsd);
  });

  it("is zero across the board for an empty plan", () => {
    const estimate = estimateCost({ triageTitles: 0, deepScores: 0, batchSize: 40, cost });
    expect(estimate.triageBatches).toBe(0);
    expect(estimate.totalUsd).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/matching/cost-estimate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add cost constants to the provider config**

In `src/matching/llm-providers.ts`, extend `LlmProviderConfig` and the `anthropic` entry:

```ts
export interface LlmProviderConfig {
  id: LlmProviderId;
  apiKeySetting: string;
  defaultModel: string;
  /** Rough per-call USD rates used only for the `score --dry-run` cost preview (not billing). */
  cost: { perTriageTitleUsd: number; perDeepScoreUsd: number };
  createClient(opts: { apiKey: string; model: string }): LlmClient;
}
```

In the `anthropic` provider object, add:

```ts
    // Approximate Sonnet rates for the dry-run preview; titles are tiny, deep scores carry the
    // full description. Tune as real usage data arrives — this is a labeled estimate, not billing.
    cost: { perTriageTitleUsd: 0.002, perDeepScoreUsd: 0.03 },
```

- [ ] **Step 4: Write the estimator**

Create `src/matching/cost-estimate.ts`:

```ts
export type CostEstimate = {
  triageTitles: number;
  triageBatches: number;
  deepScores: number;
  triageUsd: number;
  deepScoreUsd: number;
  totalUsd: number;
};

/**
 * Pure cost estimate for a `score` run. A labeled approximation for the dry-run preview, never a
 * billing guarantee. `triageBatches` is the number of LLM triage calls (titles / batchSize, ceil).
 */
export function estimateCost(opts: {
  triageTitles: number;
  deepScores: number;
  batchSize: number;
  cost: { perTriageTitleUsd: number; perDeepScoreUsd: number };
}): CostEstimate {
  const { triageTitles, deepScores, batchSize, cost } = opts;
  const triageBatches = triageTitles === 0 ? 0 : Math.ceil(triageTitles / batchSize);
  const triageUsd = triageTitles * cost.perTriageTitleUsd;
  const deepScoreUsd = deepScores * cost.perDeepScoreUsd;
  return {
    triageTitles,
    triageBatches,
    deepScores,
    triageUsd,
    deepScoreUsd,
    totalUsd: triageUsd + deepScoreUsd,
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/matching/cost-estimate.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
npm run lint:fix
npm run typecheck
git add src/matching/llm-providers.ts src/matching/cost-estimate.ts src/matching/cost-estimate.test.ts
git commit -m "feat(matching): add per-provider cost rates and a dry-run cost estimator"
```

---

### Task 6: `remote_only` setting key + resolver

**Files:**
- Modify: `src/matching/settings-keys.ts` (add `REMOTE_ONLY_SETTING`)
- Create: `src/matching/resolve-remote.ts`
- Test: `src/matching/resolve-remote.test.ts`

**Interfaces:**
- Consumes: `SettingsReader` (`@app/matching/resolve-settings`).
- Produces:
  - `REMOTE_ONLY_SETTING = "remoteOnly"` (in settings-keys.ts).
  - `resolveRemoteOnly(settings: SettingsReader, override?: boolean): boolean` — `override` wins when defined; otherwise reads the setting (`"true"` → true, anything else / unset → false).

- [ ] **Step 1: Write the failing test**

Create `src/matching/resolve-remote.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SettingsReader } from "./resolve-settings";
import { REMOTE_ONLY_SETTING } from "./settings-keys";
import { resolveRemoteOnly } from "./resolve-remote";

function settings(value?: string): SettingsReader {
  return { getSetting: (key) => (key === REMOTE_ONLY_SETTING ? value : undefined) };
}

describe("resolveRemoteOnly", () => {
  it("returns the stored setting when no override is given", () => {
    expect(resolveRemoteOnly(settings("true"))).toBe(true);
    expect(resolveRemoteOnly(settings("false"))).toBe(false);
    expect(resolveRemoteOnly(settings(undefined))).toBe(false);
  });

  it("lets an explicit override win over the stored setting", () => {
    expect(resolveRemoteOnly(settings("true"), false)).toBe(false);
    expect(resolveRemoteOnly(settings("false"), true)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/matching/resolve-remote.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Add the setting key**

In `src/matching/settings-keys.ts`, append:

```ts
export const REMOTE_ONLY_SETTING = "remoteOnly";
```

- [ ] **Step 4: Write the resolver**

Create `src/matching/resolve-remote.ts`:

```ts
import type { SettingsReader } from "./resolve-settings";
import { REMOTE_ONLY_SETTING } from "./settings-keys";

/**
 * Resolve the remote-only preference: an explicit per-run override wins; otherwise the saved
 * `remoteOnly` setting (`"true"` enables it, anything else / unset disables it).
 */
export function resolveRemoteOnly(settings: SettingsReader, override?: boolean): boolean {
  if (override !== undefined) return override;
  return settings.getSetting(REMOTE_ONLY_SETTING) === "true";
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/matching/resolve-remote.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
npm run lint:fix
npm run typecheck
git add src/matching/settings-keys.ts src/matching/resolve-remote.ts src/matching/resolve-remote.test.ts
git commit -m "feat(matching): add remote-only setting key and resolver"
```

---

### Task 7: `score-run.ts` orchestrator

**Files:**
- Create: `src/matching/score-run.ts`
- Test: `src/matching/score-run.test.ts`

**Interfaces:**
- Consumes: `Repository` (via a structural subset), `ScoringCandidate`, `SkillProfile`, `Scorer`, `LlmTriager`, `isRemote`, `estimateCost`, `Warning`, `MatchResult`.
- Produces:
  - `type UsageLimitError` detection helper `isUsageLimitError(error: unknown): boolean` — matches the provider usage-limit / auth `400` message.
  - `type ScoreOptions = { minHeuristic: number; limit: number; remoteOnly: boolean; rescore: boolean; dryRun: boolean; batchSize: number; cost: { perTriageTitleUsd: number; perDeepScoreUsd: number } }`.
  - `type ScoreStageCounts = { inDb: number; afterRemote: number; afterHeuristic: number; afterCap: number; alreadyScoredSkipped: number; triageTitles: number; deepScored: number }`.
  - `type ScoreOutcome = { counts: ScoreStageCounts; estimate: CostEstimate; warnings: Warning[]; abortedOnLimit: boolean }`.
  - `type ScoreRepo` — structural: `{ countLivePostings(): number; listPostingsForScoring(opts: { minHeuristic: number }): ScoringCandidate[]; saveMatchResult(id: string, result: MatchResult, scorer: "heuristic" | "llm"): void }`.
  - `async function runScoreRun(deps: { repo: ScoreRepo; profile: SkillProfile; triager: LlmTriager; scorer: Scorer; options: ScoreOptions; onWarning?: (w: Warning) => void }): Promise<ScoreOutcome>`.

- [ ] **Step 1: Write the failing tests**

Create `src/matching/score-run.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { JobPosting, MatchResult, SkillProfile, Warning } from "@app/domain/types";
import type { ScoringCandidate } from "@app/storage/repository";
import { FakeTriageClient } from "./triage-client";
import { LlmTriager } from "./llm-triager";
import { runScoreRun, type ScoreOptions, type ScoreRepo } from "./score-run";

const profile: SkillProfile = { skills: ["ts"], roleKeywords: [], categories: [] };

function posting(id: string, title: string, location?: string): JobPosting {
  return {
    id,
    company: "acme",
    title,
    url: `https://example.test/${id}`,
    source: "test",
    description: `${title} description`,
    ...(location ? { location } : {}),
    fetchedAt: new Date("2026-06-26T00:00:00Z"),
  };
}

function candidate(
  id: string,
  title: string,
  heuristicScore: number,
  opts: { location?: string; alreadyLlmScored?: boolean } = {},
): ScoringCandidate {
  return {
    posting: posting(id, title, opts.location),
    heuristicScore,
    alreadyLlmScored: opts.alreadyLlmScored ?? false,
  };
}

/** In-memory ScoreRepo capturing saved results. */
function fakeRepo(candidates: ScoringCandidate[]): {
  repo: ScoreRepo;
  saved: { id: string; result: MatchResult; scorer: "heuristic" | "llm" }[];
} {
  const saved: { id: string; result: MatchResult; scorer: "heuristic" | "llm" }[] = [];
  const repo: ScoreRepo = {
    countLivePostings: () => candidates.length,
    listPostingsForScoring: ({ minHeuristic }) =>
      candidates.filter((c) => c.heuristicScore >= minHeuristic),
    saveMatchResult: (id, result, scorer) => saved.push({ id, result, scorer }),
  };
  return { repo, saved };
}

const baseOptions: ScoreOptions = {
  minHeuristic: 30,
  limit: 100,
  remoteOnly: false,
  rescore: false,
  dryRun: false,
  batchSize: 40,
  cost: { perTriageTitleUsd: 0.002, perDeepScoreUsd: 0.03 },
};

/** A Scorer that returns a fixed score derived from the posting id length (deterministic, no hardcode). */
const deepScorer = {
  score: (_p: SkillProfile, posting: JobPosting): MatchResult => ({
    score: posting.title.length,
    matchedSkills: [],
    missingSkills: [],
    rationale: "deep",
  }),
};

function keepAllTriager(): LlmTriager {
  // FakeTriageClient keeping every id in the batch.
  const client = new FakeTriageClient((request) => ({
    decisions: request.user
      .split("\n")
      .filter((line) => line.includes("id="))
      .map((line) => {
        const id = line.split("id=")[1]?.split(" ")[0] ?? "";
        return { id, keep: true, reason: "keep" };
      }),
  }));
  return new LlmTriager(client, baseOptions.batchSize);
}

describe("runScoreRun", () => {
  it("gates by heuristic floor, caps by limit, and deep-scores survivors", async () => {
    const candidates = [
      candidate("a", "Staff Engineer", 80),
      candidate("b", "Backend Engineer", 45),
      candidate("c", "Sales Rep", 10), // below floor
    ];
    const { repo, saved } = fakeRepo(candidates);

    const outcome = await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, limit: 1 },
    });

    expect(outcome.counts.afterHeuristic).toBe(2);
    expect(outcome.counts.afterCap).toBe(1);
    // Only the top-by-heuristic ("a") is deep-scored, tagged llm.
    expect(saved).toEqual([
      { id: "a", result: { score: "Staff Engineer".length, matchedSkills: [], missingSkills: [], rationale: "deep" }, scorer: "llm" },
    ]);
  });

  it("skips already-LLM-scored postings unless rescore is set", async () => {
    const candidates = [candidate("a", "Staff Engineer", 80, { alreadyLlmScored: true })];
    const skip = await runScoreRun({
      repo: fakeRepo(candidates).repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: baseOptions,
    });
    expect(skip.counts.alreadyScoredSkipped).toBe(1);
    expect(skip.counts.deepScored).toBe(0);

    const forced = fakeRepo(candidates);
    const rescore = await runScoreRun({
      repo: forced.repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, rescore: true },
    });
    expect(rescore.counts.deepScored).toBe(1);
    expect(forced.saved.length).toBe(1);
  });

  it("drops non-remote postings when remoteOnly is on (unknown location kept)", async () => {
    const candidates = [
      candidate("remote", "Engineer A", 70, { location: "Remote - US" }),
      candidate("onsite", "Engineer B", 70, { location: "London, UK" }),
      candidate("unknown", "Engineer C", 70),
    ];
    const { repo, saved } = fakeRepo(candidates);

    const outcome = await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, remoteOnly: true },
    });

    expect(outcome.counts.afterRemote).toBe(2);
    expect(saved.map((s) => s.id).sort()).toEqual(["remote", "unknown"]);
  });

  it("dry-run spends nothing: no triage calls, no saves, estimate populated", async () => {
    const candidates = [candidate("a", "Staff Engineer", 80)];
    const { repo, saved } = fakeRepo(candidates);
    // A triager whose client throws — proves dry-run never calls it.
    const throwingTriager = new LlmTriager(new FakeTriageClient(new Error("should not be called")), 40);

    const outcome = await runScoreRun({
      repo,
      profile,
      triager: throwingTriager,
      scorer: deepScorer,
      options: { ...baseOptions, dryRun: true },
    });

    expect(saved).toEqual([]);
    expect(outcome.counts.deepScored).toBe(0);
    expect(outcome.estimate.deepScores).toBe(1);
    expect(outcome.estimate.totalUsd).toBeGreaterThan(0);
  });

  it("aborts deep-scoring on a usage-limit error and reports it", async () => {
    const candidates = [
      candidate("a", "Engineer A", 80),
      candidate("b", "Engineer B", 70),
    ];
    const { repo, saved } = fakeRepo(candidates);
    const warnings: Warning[] = [];
    const limitScorer = {
      score: () => {
        throw new Error(
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits."}}',
        );
      },
    };

    const outcome = await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: limitScorer,
      options: baseOptions,
      onWarning: (w) => warnings.push(w),
    });

    expect(outcome.abortedOnLimit).toBe(true);
    expect(saved.length).toBe(0);
    expect(warnings.some((w) => /usage limit|abort/i.test(w.message))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/matching/score-run.test.ts`
Expected: FAIL — `score-run` not found.

- [ ] **Step 3: Write the orchestrator**

Create `src/matching/score-run.ts`:

```ts
import type { JobPosting, MatchResult, Scorer, SkillProfile, Warning } from "@app/domain/types";
import { errorMessage } from "@app/net/error-message";
import type { ScoringCandidate } from "@app/storage/repository";
import { type CostEstimate, estimateCost } from "./cost-estimate";
import type { LlmTriager } from "./llm-triager";
import { isRemote } from "./remote-filter";
import type { TriageItem } from "./triage-prompt";

const WARNING_SOURCE = "score";

/** A provider usage-limit / auth failure — the signal to stop making new LLM calls immediately. */
export function isUsageLimitError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("usage limit") ||
    message.includes("usage limits") ||
    message.includes("rate limit") ||
    message.includes("authentication")
  );
}

export type ScoreOptions = {
  minHeuristic: number;
  limit: number;
  remoteOnly: boolean;
  rescore: boolean;
  dryRun: boolean;
  batchSize: number;
  cost: { perTriageTitleUsd: number; perDeepScoreUsd: number };
};

export type ScoreStageCounts = {
  inDb: number;
  afterRemote: number;
  afterHeuristic: number;
  afterCap: number;
  alreadyScoredSkipped: number;
  triageTitles: number;
  deepScored: number;
};

export type ScoreOutcome = {
  counts: ScoreStageCounts;
  estimate: CostEstimate;
  warnings: Warning[];
  abortedOnLimit: boolean;
};

/** Structural repo subset score-run needs — keeps the orchestrator unit-testable without SQLite. */
export type ScoreRepo = {
  countLivePostings(): number;
  listPostingsForScoring(opts: { minHeuristic: number }): ScoringCandidate[];
  saveMatchResult(id: string, result: MatchResult, scorer: "heuristic" | "llm"): void;
};

/**
 * Run the `score` pipeline over postings already in the DB: remote filter → heuristic gate (the
 * repo query applies the floor) → cap → skip-already-scored → batch title-triage → deep score.
 * Dry-run computes the plan + estimate and returns before any LLM call. Deep-scoring aborts on the
 * first usage-limit error (no point hammering a hard limit). Never throws; warnings are collected.
 */
export async function runScoreRun(deps: {
  repo: ScoreRepo;
  profile: SkillProfile;
  triager: LlmTriager;
  scorer: Scorer;
  options: ScoreOptions;
  onWarning?: (warning: Warning) => void;
}): Promise<ScoreOutcome> {
  const { repo, profile, triager, scorer, options, onWarning } = deps;
  const warnings: Warning[] = [];
  const warn = (message: string) => {
    const warning = { source: WARNING_SOURCE, message };
    warnings.push(warning);
    onWarning?.(warning);
  };

  // True total of non-expired postings in the DB, before any filtering.
  const inDb = repo.countLivePostings();

  // Heuristic gate is applied by the query (score >= minHeuristic).
  const gated = repo.listPostingsForScoring({ minHeuristic: options.minHeuristic });

  const afterRemote = options.remoteOnly
    ? gated.filter((c) => isRemote(c.posting.location))
    : gated;

  const capped = afterRemote.slice(0, options.limit);

  const eligible = options.rescore ? capped : capped.filter((c) => !c.alreadyLlmScored);
  const alreadyScoredSkipped = capped.length - eligible.length;

  const counts: ScoreStageCounts = {
    inDb,
    afterRemote: afterRemote.length,
    afterHeuristic: gated.length,
    afterCap: capped.length,
    alreadyScoredSkipped,
    triageTitles: eligible.length,
    deepScored: 0,
  };

  const estimate = estimateCost({
    triageTitles: eligible.length,
    deepScores: eligible.length,
    batchSize: options.batchSize,
    cost: options.cost,
  });

  if (options.dryRun) {
    return { counts, estimate, warnings, abortedOnLimit: false };
  }

  // Stage 4 — batch title triage (fail-open inside the triager).
  const items: TriageItem[] = eligible.map((c) => ({
    id: c.posting.id,
    title: c.posting.title,
    ...(c.posting.location ? { location: c.posting.location } : {}),
  }));
  const { keptIds } = await triager.triage(profile, items);
  const survivors = eligible.filter((c) => keptIds.has(c.posting.id));

  // Stage 5 — deep score, aborting on the first usage-limit error.
  let abortedOnLimit = false;
  for (const candidate of survivors) {
    try {
      const result = await scoreOne(scorer, profile, candidate.posting);
      repo.saveMatchResult(candidate.posting.id, result, "llm");
      counts.deepScored += 1;
    } catch (error) {
      if (isUsageLimitError(error)) {
        abortedOnLimit = true;
        warn(
          `hit the provider usage limit after ${counts.deepScored} deep score(s); ` +
            `${survivors.length - counts.deepScored} remaining were not scored`,
        );
        break;
      }
      warn(`deep score failed for ${candidate.posting.title}: ${errorMessage(error)}`);
    }
  }

  return { counts, estimate, warnings, abortedOnLimit };
}

/** Await a `Scorer.score` whether it returns a value or a promise. */
async function scoreOne(
  scorer: Scorer,
  profile: SkillProfile,
  posting: JobPosting,
): Promise<MatchResult> {
  return scorer.score(profile, posting);
}
```

NOTE: the `LlmScorer` itself degrades to the heuristic on a *generic* failure and would NOT throw a usage-limit error to `score-run`. To make early-abort work, Task 8 wires `score` to deep-score with a **raw** `LlmScorer` whose fallback is a scorer that re-throws usage-limit errors — see Task 8 Step 4. The `limitScorer` test above simulates that surfaced error directly.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/matching/score-run.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npm run lint:fix
npm run typecheck
git add src/matching/score-run.ts src/matching/score-run.test.ts
git commit -m "feat(matching): add score-run orchestrator (gate, cap, triage, deep score)"
```

---

### Task 8: Wire `scan` to heuristic-only; add `runScoreCommand` + dry-run output

**Files:**
- Modify: `src/cli/commands.ts` (export a `formatScorePlan` + `runScore` helper; keep `runScan` signature)
- Modify: `src/cli/main.ts` (swap scan to heuristic scorer; add `runScoreCommand`)
- Modify: `src/server/scan-runner.ts` (background scan uses heuristic scorer)
- Test: `src/cli/commands.test.ts`

**Interfaces:**
- Consumes: `runScoreRun`, `ScoreOutcome`, `ScoreOptions`, `estimateCost`, `HeuristicScorer`, `LlmScorer`, `LlmTriager`, `AnthropicTriageClient`, `resolveProvider`/`resolveApiKey`/`resolveScorerModel`, `resolveRemoteOnly`, provider `cost`.
- Produces:
  - `formatScorePlan(outcome: ScoreOutcome, opts: { remoteOnly: boolean; limit: number; dryRun: boolean }): string` — the human-readable plan/summary block.
  - In `main.ts`: `runScoreCommand(repo: Repository, options: ScoreCliOptions, log: Logger): Promise<void>` where `ScoreCliOptions = { minHeuristic: number; limit: number; remoteOnly?: boolean; rescore: boolean; dryRun: boolean }`.

- [ ] **Step 1: Write the failing test for `formatScorePlan`**

Add to `src/cli/commands.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatScorePlan } from "./commands";
import type { ScoreOutcome } from "@app/matching/score-run";

function outcome(overrides: Partial<ScoreOutcome["counts"]> = {}): ScoreOutcome {
  const counts = {
    inDb: 200,
    afterRemote: 120,
    afterHeuristic: 200,
    afterCap: 100,
    alreadyScoredSkipped: 18,
    triageTitles: 82,
    deepScored: 0,
    ...overrides,
  };
  return {
    counts,
    estimate: {
      triageTitles: counts.triageTitles,
      triageBatches: 3,
      deepScores: counts.triageTitles,
      triageUsd: 0.16,
      deepScoreUsd: 2.46,
      totalUsd: 2.62,
    },
    warnings: [],
    abortedOnLimit: false,
  };
}

describe("formatScorePlan", () => {
  it("shows the db total, cap, skipped count, and estimated total for a dry run", () => {
    const result = outcome();
    const text = formatScorePlan(result, { remoteOnly: true, limit: 100, dryRun: true });
    expect(text).toContain(String(result.counts.inDb));
    expect(text).toContain("100");
    expect(text).toContain("18");
    expect(text).toContain("2.62");
  });

  it("reports how many were deep-scored after a real run", () => {
    const text = formatScorePlan(outcome({ deepScored: 80 }), {
      remoteOnly: false,
      limit: 100,
      dryRun: false,
    });
    expect(text).toContain("80");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/cli/commands.test.ts -t "formatScorePlan"`
Expected: FAIL — `formatScorePlan` not exported.

- [ ] **Step 3: Add `formatScorePlan` to `commands.ts`**

Append to `src/cli/commands.ts` (import `ScoreOutcome` at the top):

```ts
import type { ScoreOutcome } from "@app/matching/score-run";

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** A human-readable plan/summary for a `score` run (dry-run preview or post-run report). */
export function formatScorePlan(
  outcome: ScoreOutcome,
  opts: { remoteOnly: boolean; limit: number; dryRun: boolean },
): string {
  const { counts, estimate } = outcome;
  const lines = [
    style.bold(opts.dryRun ? "Score plan (dry run)" : "Score run"),
    `  In DB:              ${counts.inDb} postings`,
    `  Heuristic-gated:    ${counts.afterHeuristic}`,
    `  Remote filter:      ${counts.afterRemote} remain   (remote_only=${opts.remoteOnly ? "on" : "off"})`,
    `  Cap (--limit ${opts.limit}):   ${counts.afterCap} selected`,
    `  Already LLM-scored: ${counts.alreadyScoredSkipped} skipped   (--rescore to re-score)`,
    `  Triage:             ${estimate.triageTitles} titles (${estimate.triageBatches} batch(es))   est. ~${usd(estimate.triageUsd)}`,
    `  Deep-score (max):   ${estimate.deepScores}                 est. ~${usd(estimate.deepScoreUsd)}`,
    `  Estimated total:                          ~${usd(estimate.totalUsd)}`,
  ];
  if (!opts.dryRun) {
    lines.push(`  Deep-scored:        ${counts.deepScored}`);
    if (outcome.abortedOnLimit) {
      lines.push(style.warn("  ! Stopped early — provider usage limit reached."));
    }
  } else {
    lines.push(style.dim("  (estimate only — no LLM calls made; rates are approximate)"));
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Add `runScoreCommand` to `main.ts`**

In `src/cli/main.ts`, add imports and the command. The deep scorer calls the raw provider client and **re-throws usage-limit errors** so `score-run` can abort, while degrading ordinary failures to the heuristic:

```ts
import { HeuristicScorer } from "@app/matching/heuristic-scorer";
import { LlmTriager } from "@app/matching/llm-triager";
import { AnthropicTriageClient } from "@app/matching/triage-client";
import { runScoreRun, isUsageLimitError } from "@app/matching/score-run";
import { resolveRemoteOnly } from "@app/matching/resolve-remote";
import { buildScorePrompt, toMatchResult } from "@app/matching/score-prompt";
import { MatchPayloadSchema } from "@app/matching/llm-schema";
import { errorMessage } from "@app/net/error-message";
import {
  resolveApiKey,
  resolveProvider,
  resolveScorerModel,
} from "@app/matching/resolve-settings";
import { formatScorePlan } from "./commands";
import type { Scorer, SkillProfile, JobPosting, MatchResult } from "@app/domain/types";

const TRIAGE_BATCH_SIZE = 40;

export type ScoreCliOptions = {
  minHeuristic: number;
  limit: number;
  remoteOnly?: boolean;
  rescore: boolean;
  dryRun: boolean;
};

export async function runScoreCommand(
  repo: Repository,
  options: ScoreCliOptions,
  log: Logger,
): Promise<void> {
  const profile = repo.getLatestProfile();
  if (!profile) {
    log(style.warn("No profile yet. Run `job-hunter profile <resume-file>` first."));
    process.exitCode = 1;
    return;
  }

  const settings = settingsWithEnvKey(repo);
  const provider = resolveProvider(settings);
  const apiKey = resolveApiKey(settings, provider);
  if (!apiKey) {
    log(
      style.warn(
        "No LLM key configured; nothing to score (scan already heuristic-scored everything).",
      ),
    );
    return;
  }

  const model = resolveScorerModel(settings, provider);
  const dictionary = repo.getSkillDictionary();
  const warnings: Warning[] = [];

  // Deep-score against the raw provider client. We do NOT reuse `LlmScorer` here because it
  // degrades EVERY failure (including a usage-limit error) into the heuristic fallback, which
  // would hide the very signal `score-run` needs to abort the run. Instead this scorer degrades
  // ordinary failures to the heuristic but re-throws usage-limit errors so `runScoreRun` can stop.
  const heuristic = new HeuristicScorer(dictionary.length > 0 ? dictionary : undefined);
  const rawClient = provider.createClient({ apiKey, model });
  const abortingScorer: Scorer = {
    score: async (profileArg: SkillProfile, posting: JobPosting): Promise<MatchResult> => {
      try {
        const payload = await rawClient.score(buildScorePrompt(profileArg, posting));
        const parsed = MatchPayloadSchema.safeParse(payload);
        if (!parsed.success) return heuristic.score(profileArg, posting);
        return toMatchResult(parsed.data);
      } catch (error) {
        if (isUsageLimitError(error)) throw error; // let score-run abort the whole run
        warnings.push({
          source: "llm-scorer",
          message: `LLM scoring failed: ${errorMessage(error)}; using the heuristic scorer`,
        });
        return heuristic.score(profileArg, posting);
      }
    },
  };

  const triager = new LlmTriager(
    new AnthropicTriageClient({ apiKey, model }),
    TRIAGE_BATCH_SIZE,
    (warning) => warnings.push(warning),
  );

  const outcome = await runScoreRun({
    repo,
    profile,
    triager,
    scorer: abortingScorer,
    options: {
      minHeuristic: options.minHeuristic,
      limit: options.limit,
      remoteOnly: resolveRemoteOnly(settings, options.remoteOnly),
      rescore: options.rescore,
      dryRun: options.dryRun,
      batchSize: TRIAGE_BATCH_SIZE,
      cost: provider.cost,
    },
    onWarning: (warning) => warnings.push(warning),
  });

  log(
    formatScorePlan(outcome, {
      remoteOnly: resolveRemoteOnly(settings, options.remoteOnly),
      limit: options.limit,
      dryRun: options.dryRun,
    }),
  );
  for (const warning of warnings) {
    log(style.warn(`  ! [${warning.source}] ${warning.message}`));
  }
}
```

The imports this block needs at the top of `main.ts` (static, not dynamic):

```ts
import { buildScorePrompt, toMatchResult } from "@app/matching/score-prompt";
import { MatchPayloadSchema } from "@app/matching/llm-schema";
import { errorMessage } from "@app/net/error-message";
```

(The `LlmScorer` import shown earlier in the import list is not needed for `score`; drop it if added.)

- [ ] **Step 5: Switch `scan` (CLI + server) to the heuristic scorer**

In `src/cli/main.ts` `runScanCommand`, replace the `resolveScorer({...})` call with:

```ts
const dictionary = repo.getSkillDictionary();
const scorer = new HeuristicScorer(dictionary.length > 0 ? dictionary : undefined);
```

Remove the now-unused `resolveScorer` import from `main.ts` if nothing else uses it. Drop the `warnings` accumulation that only captured scorer warnings if it's now empty (keep discovery warnings via `result.warnings`).

In `src/server/scan-runner.ts`, make the same swap: replace `resolveScorer({...})` with `new HeuristicScorer(dictionary.length > 0 ? dictionary : undefined)` and drop the scorer `warnings` array (keep `result.warnings`). Import `HeuristicScorer` from `@app/matching/heuristic-scorer`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/cli/commands.test.ts`
Expected: PASS.

- [ ] **Step 7: Update existing scan tests that asserted LLM scoring**

Run: `npx vitest run src/cli/main.test.ts src/server/scan-job.test.ts`
Expected: Some may fail if they asserted `resolveScorer`/LLM behavior in scan. Update them to expect the heuristic scorer (scan no longer makes LLM calls). Adjust assertions to the new behavior; do not hard-code expected scores — derive from the heuristic over fixture inputs.

- [ ] **Step 8: Lint, typecheck, full suite, commit**

```bash
npm run lint:fix
npm run typecheck
npm test
git add src/cli/commands.ts src/cli/main.ts src/server/scan-runner.ts src/cli/commands.test.ts src/cli/main.test.ts src/server/scan-job.test.ts
git commit -m "feat(cli): make scan heuristic-only and add the score command wiring"
```

---

### Task 9: CLI parsing for `score` and `config remote`

**Files:**
- Modify: `src/cli/parse.ts` (add `score` + `config` commands)
- Modify: `src/cli/main.ts` (dispatch `score` + `config`)
- Test: `src/cli/parse.test.ts`

**Interfaces:**
- Consumes: `parseArgs`, `COMMAND_NAMES`.
- Produces (added to the `Command` union):
  - `{ kind: "score"; minHeuristic: number; limit: number; remoteOnly?: boolean; rescore: boolean; dryRun: boolean }`
  - `{ kind: "config-remote"; on: boolean }`
  - Exported defaults: `DEFAULT_MIN_HEURISTIC = 30`, `DEFAULT_SCORE_LIMIT = 100`.

- [ ] **Step 1: Write the failing tests**

Add to `src/cli/parse.test.ts`:

```ts
import { DEFAULT_MIN_HEURISTIC, DEFAULT_SCORE_LIMIT, parseCli } from "./parse";

describe("score command", () => {
  it("defaults min-heuristic and limit", () => {
    expect(parseCli(["score"])).toEqual({
      kind: "score",
      minHeuristic: DEFAULT_MIN_HEURISTIC,
      limit: DEFAULT_SCORE_LIMIT,
      rescore: false,
      dryRun: false,
    });
  });

  it("parses the knobs and flags", () => {
    expect(parseCli(["score", "--min-heuristic", "40", "--limit", "25", "--rescore", "--dry-run", "--remote"])).toEqual({
      kind: "score",
      minHeuristic: 40,
      limit: 25,
      remoteOnly: true,
      rescore: true,
      dryRun: true,
    });
  });

  it("parses --no-remote as an explicit override", () => {
    const cmd = parseCli(["score", "--no-remote"]);
    expect(cmd).toMatchObject({ kind: "score", remoteOnly: false });
  });
});

describe("config remote command", () => {
  it("parses on/off", () => {
    expect(parseCli(["config", "remote", "on"])).toEqual({ kind: "config-remote", on: true });
    expect(parseCli(["config", "remote", "off"])).toEqual({ kind: "config-remote", on: false });
  });

  it("errors on a bad value", () => {
    expect(parseCli(["config", "remote", "maybe"]).kind).toBe("help");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/cli/parse.test.ts -t "score command"`
Expected: FAIL — `score` not parsed.

- [ ] **Step 3: Implement parsing**

In `src/cli/parse.ts`: add the defaults and union members, then the cases.

Add near `DEFAULT_MIN_SCORE`:

```ts
export const DEFAULT_MIN_HEURISTIC = 30;
export const DEFAULT_SCORE_LIMIT = 100;
```

Add to the `Command` union:

```ts
  | { kind: "score"; minHeuristic: number; limit: number; remoteOnly?: boolean; rescore: boolean; dryRun: boolean }
  | { kind: "config-remote"; on: boolean }
```

Add cases in the `switch (command)`:

```ts
    case "score": {
      const { values } = parseArgs({
        args: rest,
        options: {
          "min-heuristic": { type: "string" },
          limit: { type: "string" },
          remote: { type: "boolean" },
          "no-remote": { type: "boolean" },
          rescore: { type: "boolean" },
          "dry-run": { type: "boolean" },
        },
        allowPositionals: true,
      });
      const minRaw = values["min-heuristic"];
      const limitRaw = values.limit;
      const minHeuristic = minRaw === undefined ? DEFAULT_MIN_HEURISTIC : Number(minRaw);
      const limit = limitRaw === undefined ? DEFAULT_SCORE_LIMIT : Number(limitRaw);
      if (!Number.isFinite(minHeuristic) || minHeuristic < 0) {
        return { kind: "help", error: `invalid --min-heuristic: ${minRaw}` };
      }
      if (!Number.isInteger(limit) || limit < 1) {
        return { kind: "help", error: `invalid --limit: ${limitRaw}` };
      }
      const cmd: Extract<Command, { kind: "score" }> = {
        kind: "score",
        minHeuristic,
        limit,
        rescore: Boolean(values.rescore),
        dryRun: Boolean(values["dry-run"]),
      };
      // --remote / --no-remote are explicit overrides; absent means "use the saved setting".
      if (values.remote) cmd.remoteOnly = true;
      else if (values["no-remote"]) cmd.remoteOnly = false;
      return cmd;
    }

    case "config": {
      const [sub, ...configRest] = rest;
      if (sub === "remote") {
        const { positionals } = parseArgs({ args: configRest, allowPositionals: true });
        const value = positionals[0];
        if (value === "on") return { kind: "config-remote", on: true };
        if (value === "off") return { kind: "config-remote", on: false };
        return { kind: "help", error: `config remote expects on|off, got: ${value ?? "(none)"}` };
      }
      return { kind: "help", error: `unknown config subcommand: ${sub ?? "(none)"}` };
    }
```

- [ ] **Step 4: Dispatch the new commands in `main.ts`**

In `src/cli/main.ts` `main()` switch, add:

```ts
      case "score":
        await runScoreCommand(
          repo,
          {
            minHeuristic: command.minHeuristic,
            limit: command.limit,
            ...(command.remoteOnly !== undefined ? { remoteOnly: command.remoteOnly } : {}),
            rescore: command.rescore,
            dryRun: command.dryRun,
          },
          log,
        );
        break;
      case "config-remote":
        repo.setSetting(REMOTE_ONLY_SETTING, command.on ? "true" : "false");
        log(style.success(`Remote-only filter ${command.on ? "enabled" : "disabled"}.`));
        break;
```

Import `REMOTE_ONLY_SETTING` from `@app/matching/settings-keys` in `main.ts`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/cli/parse.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
npm run lint:fix
npm run typecheck
git add src/cli/parse.ts src/cli/main.ts src/cli/parse.test.ts
git commit -m "feat(cli): parse and dispatch score and config remote commands"
```

---

### Task 10: Help entries + progress strings + docs

**Files:**
- Modify: `src/cli/help.ts` (update `scan` summary; add `score` + `config` entries)
- Modify: `src/cli/help.test.ts` (assert the new entries render)
- Modify: `docs/usage.md` (document the scan→score flow + remote setting)

**Interfaces:**
- Consumes: existing `COMMANDS` structure.
- Produces: `scan`, `score`, and `config` entries in `COMMANDS`.

- [ ] **Step 1: Write the failing test**

Add to `src/cli/help.test.ts`:

```ts
it("documents the score and config commands", () => {
  const help = renderHelp();
  expect(help).toContain("score");
  expect(help).toContain("config");
});

it("scan help no longer claims to score", () => {
  const scanHelp = renderHelp("scan");
  expect(scanHelp.toLowerCase()).not.toContain("scores every posting");
});
```

(Import `renderHelp` to match the existing test file's imports.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/cli/help.test.ts`
Expected: FAIL — no `score`/`config` entry.

- [ ] **Step 3: Update `COMMANDS` in `help.ts`**

Change the `scan` entry's `summary`/`details` to reflect heuristic-only:

```ts
  {
    name: "scan",
    invocation: "scan",
    summary: "Discover and store new postings (free heuristic scoring)",
    details:
      "Reads the public job directory plus any tracked companies, stores postings with a free heuristic score, and expires roles that have gone offline. Run `score` afterward for LLM scoring.",
    examples: ["job-hunter scan"],
  },
```

Add after the `scan` entry:

```ts
  {
    name: "score",
    invocation: "score [--min-heuristic N] [--limit N] [--remote|--no-remote] [--rescore] [--dry-run]",
    summary: "LLM-score the best postings from the last scan",
    details:
      "Ranks stored postings by their heuristic score, batch-triages titles with the LLM, then deep-scores the survivors. Bounded by --min-heuristic (floor) and --limit (cap). Use --dry-run to preview the plan and estimated cost without spending.",
    options: [
      ["--min-heuristic N", "Only consider postings scoring at least N heuristically (default 30)."],
      ["--limit N", "Deep-score at most N postings (default 100)."],
      ["--remote / --no-remote", "Override the saved remote-only filter for this run."],
      ["--rescore", "Re-score postings already LLM-scored in a prior run."],
      ["--dry-run", "Print the plan + estimated cost and exit without calling the LLM."],
    ],
    examples: ["job-hunter score --dry-run", "job-hunter score --limit 50 --remote"],
  },
  {
    name: "config",
    invocation: "config remote <on|off>",
    summary: "Persist the remote-only filter setting",
    details: "Saves the remote-only preference applied by `score` (overridable per-run with --remote/--no-remote).",
    optionsLabel: "SUBCOMMANDS",
    options: [["remote <on|off>", "Enable or disable the remote-only filter."]],
    examples: ["job-hunter config remote on"],
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/cli/help.test.ts`
Expected: PASS.

- [ ] **Step 5: Update `docs/usage.md`**

Add a short section after the existing scan documentation describing the two-step flow:

```markdown
## Scanning and scoring

`scan` discovers postings and stores them with a free heuristic score — no LLM, no cost:

    job-hunter scan

`score` then LLM-scores the best of them. It ranks by heuristic score, gates with
`--min-heuristic` (default 30), caps with `--limit` (default 100), batch-triages titles, and
deep-scores the survivors. Preview spend first with `--dry-run`:

    job-hunter score --dry-run
    job-hunter score --limit 50

Already-LLM-scored postings are skipped on re-runs; pass `--rescore` to force them.

### Remote-only filter

Persist a remote-only preference so `score` skips non-remote roles (postings with no location are
kept):

    job-hunter config remote on

Override per run with `--remote` / `--no-remote`.
```

- [ ] **Step 6: Lint, typecheck, full suite, coverage, commit**

```bash
npm run lint:fix
npm run typecheck
npm run test:coverage
git add src/cli/help.ts src/cli/help.test.ts docs/usage.md
git commit -m "docs(cli): document the scan/score split and remote filter"
```

---

### Task 11: Final verification

- [ ] **Step 1: Full CI-equivalent run**

```bash
npm run lint
npm run typecheck
npm run typecheck:web
npm run test:coverage
npm run build:web
```
Expected: all pass, coverage gate green (statements 93 / branches 85 / functions 90 / lines 93).

- [ ] **Step 2: Manual smoke of the dry-run path (no spend)**

```bash
npm run cli -- score --dry-run
```
Expected: prints the score plan with counts + an estimated total, makes no LLM calls. (Requires an existing DB with a profile + scanned postings; if none, it prints the no-profile or no-key guard.)

- [ ] **Step 3: Confirm scan makes no LLM calls**

Verify `runScanCommand` and `createScanRunner` reference `HeuristicScorer` and no longer call `resolveScorer`.

Run: `grep -rn "resolveScorer" src/cli/ src/server/`
Expected: no matches in `main.ts` / `scan-runner.ts` (only `resolve-scorer.ts` itself + its test).

---

## Self-Review

**Spec coverage:**
- Split scan/score into two commands → Tasks 8, 9 (scan heuristic-only; `score` command).
- Heuristic gate + cap (Option A) → Task 7 (`runScoreRun` gate/cap), Task 9 (`--min-heuristic`, `--limit`).
- Batch title-triage (keep/drop) → Tasks 3, 4 (`LlmTriager`, fail-open).
- Deep score on survivors → Task 7.
- `scorer` column + skip-already-scored + `--rescore` → Tasks 1, 7, 9.
- Remote saved setting + `--remote`/`--no-remote` + unknown-kept + non-remote stays stored → Tasks 2, 6, 7, 9.
- Dry-run cost preview → Tasks 5, 7, 8 (`estimateCost`, `dryRun` short-circuit, `formatScorePlan`).
- Cost constants in `llm-providers.ts` → Task 5.
- Error handling: fail-open triage (Task 4), early-abort on usage limit (Task 7), no-key/no-profile guards (Task 8) → covered.
- No web/domain changes; `MatchResult` unchanged → Tasks 1, 8 keep server reading `MatchResult` (scan-runner only swaps scorer).
- CLI surface + help + docs → Tasks 9, 10.

**Placeholder scan:** No TBD/TODO. Task 8's early-abort wiring is a single concrete `abortingScorer` (raw provider client + re-throw on usage-limit, degrade otherwise) with its required static imports listed. All code blocks are concrete and unambiguous.

**Type consistency:** `saveMatchResult(id, result, scorer)` signature matches across Tasks 1, 7, 8. `ScoringCandidate` (Task 1) is consumed by `ScoreRepo`/`runScoreRun` (Task 7). `ScoreOptions`/`ScoreOutcome`/`ScoreStageCounts` (Task 7) match `formatScorePlan` (Task 8) and `runScoreCommand` (Task 8). `TriageItem`/`TriageClient`/`LlmTriagePayload` consistent across Tasks 3, 4, 7. `estimateCost` signature matches between Tasks 5 and 7. `REMOTE_ONLY_SETTING` consistent across Tasks 6, 9. Parse `Command` members (Task 9) match `main.ts` dispatch (Task 9) and `runScoreCommand` options (Task 8).

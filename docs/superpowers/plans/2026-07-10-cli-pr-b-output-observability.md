# CLI Best-Practices — PR B (Output & Observability) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the CLI machine-readable output and a debug mode, on a clean stdout/stderr split — `--json` on `list` and `score` (3.2), a `--verbose`/`DEBUG` diagnostic mode (6.3), and the stderr-discipline refactor that makes them coexist (3.6).

**Architecture:** A single diagnostic sink routes progress/warnings/debug to **stderr**, leaving stdout for a command's primary result. `list --json` prints a flattened match array; `score --json` prints the run-summary object; both validated by zod schemas that also back the tests. `--verbose` (a global flag) and `DEBUG=job-hunter*` both enable a tiny local debug logger.

**Tech Stack:** TypeScript-strict ESM, `node:util` parseArgs, zod (already a dependency, used at the web contract boundary), vitest.

## Global Constraints

- TypeScript-strict; `noUncheckedIndexedAccess` on. NO `!` non-null assertions. Avoid type assertions outside tests (zod `.parse` replaces assertions at the boundary).
- No new runtime dependencies. zod is already present — reuse it. Do NOT add the `debug` npm package; write a tiny local helper.
- Biome: 2-space indent, 100-col, double quotes. Run `npm run lint:fix` before committing.
- Conventional Commits. NO Claude co-author footer.
- Tests colocated, offline, deterministic. Assert `--json` output against the zod schema and against injected fixture data — never hard-code a magic literal that duplicates the source of truth.
- Coverage gate stays green: statements 93 / branches 85 / functions 90 / lines 93.
- Failures degrade, never crash — the `--json` and diagnostic changes must not make a single warning abort a command.
- **stdout is the data channel; stderr is the diagnostics channel.** In `--json` mode stdout MUST be pure JSON (parseable by `jq`) — no ANSI, no human text, no warnings.

## Data shapes (the contract)

`list --json` → JSON array; each element (flattened from `ScoredPosting`):
```
{ score: number, company: string, title: string, url: string, source: string,
  location: string | null, remote: boolean, country: string | null,
  postedAt: string | null /* ISO */, applied: boolean, expired: boolean }
```
`score --json` → JSON object = `ScoreOutcome`: `{ counts, estimate, warnings, abortedOnLimit }`
(serialized as-is; all fields are already JSON-safe primitives/arrays).

## File Structure

- `src/cli/diagnostics.ts` — NEW: the diagnostic sink + debug logger. `createDiagnostics({ verbose, json })` returns `{ diag(msg), debug(ns, msg), isDebugEnabled }`, all writing to stderr. One focused module so both `main.ts` and `commands.ts` import one thing.
- `src/cli/diagnostics.test.ts` — NEW.
- `src/cli/json-output.ts` — NEW: the two zod schemas (`MatchJsonSchema`, `ScoreOutcomeJsonSchema`) + pure mappers (`toMatchJson(scored)`, the score outcome passes through). Pure/unit-testable, no I/O.
- `src/cli/json-output.test.ts` — NEW.
- `src/cli/parse.ts` — add `--json` to `list`/`score`; add global `--verbose`. (Modify)
- `src/cli/parse.test.ts` — append. (Modify)
- `src/cli/commands.ts` — `listMatches` gains a json path; progress/warnings route through the diagnostic sink. (Modify)
- `src/cli/main.ts` — build the diagnostics sink from parsed flags/env; thread it into list/scan/score; `score` json path. (Modify)
- `src/cli/help.ts` — document `--json` and `--verbose`. (Modify)
- `_reports/audit/cli-best-practices-2026-07-10.md` — update statuses. (Modify)

## Interfaces (locked signatures used across tasks)

- `createDiagnostics(opts: { verbose: boolean; json: boolean }): Diagnostics`
  where `type Diagnostics = { diag: (message: string) => void; debug: (namespace: string, message: string) => void; isDebugEnabled: boolean }`.
  `debugEnabledFromEnv(env: NodeJS.ProcessEnv): boolean` — true when `DEBUG` matches `job-hunter` / `job-hunter:*` / `*`.
- `MatchJson` = zod-inferred type of `MatchJsonSchema`; `toMatchJson(rows: ScoredPosting[]): MatchJson[]`.
- `Command` union gains `json: boolean` on the `list` and `score` variants, and a top-level `verbose` is parsed separately (returned from `parseCli` via a new `{ command, verbose }`? NO — keep `parseCli` returning `Command`; `--verbose` is read directly from argv in `main` like `-h`/`-v`). See Task 2.

---

### Task 1: Diagnostic sink + debug logger (3.6 + 6.3 core)

**Files:**
- Create: `src/cli/diagnostics.ts`
- Test: `src/cli/diagnostics.test.ts`

**Interfaces:**
- Produces: `createDiagnostics`, `Diagnostics`, `debugEnabledFromEnv` (signatures above).

**Design:** all output via an injectable `write: (line: string) => void` defaulting to `process.stderr.write`. This keeps the sink unit-testable without capturing the real stream. `diag` always writes (it's for progress/warnings, which belong on stderr regardless of json mode). `debug` writes only when `verbose || debugEnabledFromEnv(process.env)`; it prefixes `[namespace]`. Styling reuses `style` (which already respects NO_COLOR/TTY).

- [ ] **Step 1: Write the failing test**

Create `src/cli/diagnostics.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createDiagnostics, debugEnabledFromEnv } from "./diagnostics";

describe("debugEnabledFromEnv", () => {
  it("enables for job-hunter, namespaced, and wildcard DEBUG values", () => {
    expect(debugEnabledFromEnv({ DEBUG: "job-hunter" })).toBe(true);
    expect(debugEnabledFromEnv({ DEBUG: "job-hunter:scan" })).toBe(true);
    expect(debugEnabledFromEnv({ DEBUG: "*" })).toBe(true);
  });

  it("stays disabled when DEBUG is absent or unrelated", () => {
    expect(debugEnabledFromEnv({})).toBe(false);
    expect(debugEnabledFromEnv({ DEBUG: "other-app" })).toBe(false);
  });
});

describe("createDiagnostics", () => {
  it("diag() always writes to the sink", () => {
    const write = vi.fn();
    const d = createDiagnostics({ verbose: false, json: false }, write);
    d.diag("progress");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toContain("progress");
  });

  it("debug() writes only when verbose is on", () => {
    const off = vi.fn();
    createDiagnostics({ verbose: false, json: false }, off).debug("scan", "hi");
    expect(off).not.toHaveBeenCalled();

    const on = vi.fn();
    createDiagnostics({ verbose: true, json: false }, on).debug("scan", "hi");
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]?.[0]).toContain("scan");
    expect(on.mock.calls[0]?.[0]).toContain("hi");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/diagnostics.test.ts`
Expected: FAIL — cannot resolve `./diagnostics`.

- [ ] **Step 3: Write minimal implementation**

Create `src/cli/diagnostics.ts`:

```ts
import { style } from "./style";

/** A diagnostics sink: progress/warnings (`diag`) and debug lines (`debug`) — all to stderr. */
export type Diagnostics = {
  diag: (message: string) => void;
  debug: (namespace: string, message: string) => void;
  isDebugEnabled: boolean;
};

/** True when the `DEBUG` env var opts this app in: `job-hunter`, `job-hunter:*`, or `*`. */
export function debugEnabledFromEnv(env: NodeJS.ProcessEnv): boolean {
  const value = env.DEBUG?.trim();
  if (!value) return false;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .some((entry) => entry === "*" || entry === "job-hunter" || entry.startsWith("job-hunter:"));
}

/**
 * Build the diagnostics sink. `diag` always writes (progress/warnings belong on stderr in every
 * mode). `debug` writes only when `--verbose` or a matching `DEBUG` env var is set. `write` is
 * injectable so tests capture output without touching the real stream; it defaults to stderr.
 */
export function createDiagnostics(
  opts: { verbose: boolean; json: boolean },
  write: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
): Diagnostics {
  const isDebugEnabled = opts.verbose || debugEnabledFromEnv(process.env);
  return {
    diag: (message) => write(`${message}\n`),
    debug: (namespace, message) => {
      if (isDebugEnabled) write(`${style.dim(`[${namespace}]`)} ${message}\n`);
    },
    isDebugEnabled,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/diagnostics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/diagnostics.ts src/cli/diagnostics.test.ts
git commit -m "feat(cli): add stderr diagnostics sink and debug logger"
```

---

### Task 2: Parse `--json` (list/score) and global `--verbose` (3.2/6.3 parsing)

**Files:**
- Modify: `src/cli/parse.ts`
- Test: `src/cli/parse.test.ts` (append)

**Interfaces:**
- Consumes: existing `parseCli`.
- Produces: `Command` `list` and `score` variants each gain `json: boolean`. `--verbose` is NOT part of `Command` — it is read from argv in `main` (like `-h`/`-v`), via a new exported helper `hasVerboseFlag(argv: string[]): boolean`.

Rationale for `--verbose` as an argv scan (not a per-command option): it's global (applies to any command) and, like help/version, simplest to detect anywhere in argv rather than adding it to every options block.

- [ ] **Step 1: Write the failing tests**

Append to `src/cli/parse.test.ts` (reuse existing `parseCli`/`describe`/`it`/`expect`; add `hasVerboseFlag` to the import from `./parse`):

```ts
describe("--json flag", () => {
  it("sets json on list", () => {
    expect(parseCli(["list", "--json"])).toMatchObject({ kind: "list", json: true });
  });
  it("defaults json to false on list", () => {
    expect(parseCli(["list"])).toMatchObject({ kind: "list", json: false });
  });
  it("sets json on score", () => {
    expect(parseCli(["score", "--json"])).toMatchObject({ kind: "score", json: true });
  });
  it("defaults json to false on score", () => {
    expect(parseCli(["score"])).toMatchObject({ kind: "score", json: false });
  });
});

describe("hasVerboseFlag", () => {
  it("detects --verbose anywhere in argv", () => {
    expect(hasVerboseFlag(["scan", "--verbose"])).toBe(true);
    expect(hasVerboseFlag(["--verbose", "list"])).toBe(true);
  });
  it("is false when absent", () => {
    expect(hasVerboseFlag(["scan"])).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/cli/parse.test.ts -t "json flag"`
Run: `npx vitest run src/cli/parse.test.ts -t "hasVerboseFlag"`
Expected: FAIL — `json` not on the Command; `hasVerboseFlag` not exported.

- [ ] **Step 3: Implement in `parse.ts`**

Add `json` to the `list` and `score` variants of the `Command` union:
- In the `list` member add `json: boolean;`
- In the `score` member add `json: boolean;`

Add `"json": { type: "boolean" }` to the `options` object in BOTH the `list` case (around line 154) and the `score` case (around line 215).

In the `list` return object (around line 167) add:
```ts
        json: Boolean(values.json),
```

In the `score` `cmd` object literal (around line 237) add:
```ts
        json: Boolean(values.json),
```
(place it alongside `rescore`/`dryRun`).

Add the exported helper near the top-level of the file (after `parseCli` or before it):
```ts
/** `--verbose` is global (applies to any command); detect it anywhere in argv, like `-h`/`-v`. */
export function hasVerboseFlag(argv: string[]): boolean {
  return argv.some((a) => a === "--verbose");
}
```

Because `--verbose` may now appear in argv for any command, add `"verbose": { type: "boolean" }` to EVERY command's `options` block that uses `safeParse` (scan, serve, list, score, and track add) so `parseArgs` doesn't reject it as unknown. (Do NOT add it to bare-positional parses like `profile`/`track remove`/`config remote`, which use `safeParse({ args, allowPositionals: true })` with no `options` — those already ignore unknown-looking tokens? No: parseArgs still throws on unknown options there. Instead, strip `--verbose` before those parses: see Step 4.)

- [ ] **Step 4: Handle `--verbose` for positional-only subcommands**

To avoid `--verbose` tripping the option-less `safeParse` calls (profile, track remove, config remote), filter it out of `argv` at the very top of `parseCli`, right after help/version detection, since it's consumed globally by `main` not by any command:

```ts
  // `--verbose` is consumed globally (see hasVerboseFlag in main); remove it before per-command
  // parsing so option-less subcommands don't reject it as an unknown flag.
  const argvForCommand = argv.filter((a) => a !== "--verbose");
  const [command, ...rest] = argvForCommand;
```
Then replace the existing `const [command, ...rest] = argv;` with the above (the help/version scans above it still use the original `argv`, which is correct — they should see `--verbose` too, harmlessly). Remove the now-redundant per-command `"verbose"` option additions from Step 3 if you took the filter approach — the filter is the single-point solution; prefer it. (Keep Step 3's `--json` additions.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/cli/parse.test.ts`
Expected: PASS (new + all existing).

- [ ] **Step 6: Commit**

```bash
git add src/cli/parse.ts src/cli/parse.test.ts
git commit -m "feat(cli): parse --json on list/score and global --verbose"
```

---

### Task 3: JSON output schemas + mapper (3.2 contract)

**Files:**
- Create: `src/cli/json-output.ts`
- Test: `src/cli/json-output.test.ts`

**Interfaces:**
- Consumes: `ScoredPosting` (from `@app/storage/repository`), `ScoreOutcome` (from `@app/matching/score-run`).
- Produces: `MatchJsonSchema`, `MatchJson`, `toMatchJson(rows: ScoredPosting[]): MatchJson[]`, `ScoreOutcomeJsonSchema`.

- [ ] **Step 1: Write the failing test**

Create `src/cli/json-output.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ScoredPosting } from "@app/storage/repository";
import { MatchJsonSchema, toMatchJson } from "./json-output";

function scoredFixture(overrides: Partial<ScoredPosting> = {}): ScoredPosting {
  return {
    posting: {
      id: "p1",
      company: "acme",
      title: "Staff Engineer",
      url: "https://acme.example/jobs/1",
      source: "greenhouse",
      description: "desc",
      remote: true,
      fetchedAt: new Date("2026-07-01T00:00:00.000Z"),
    },
    result: { score: 87, matchedSkills: [], missingSkills: [] },
    action: null,
    expired: false,
    ...overrides,
  };
}

describe("toMatchJson", () => {
  it("flattens a scored posting into the JSON contract and validates against the schema", () => {
    const [record] = toMatchJson([scoredFixture()]);
    expect(() => MatchJsonSchema.parse(record)).not.toThrow();
    expect(record).toMatchObject({
      score: 87,
      company: "acme",
      title: "Staff Engineer",
      url: "https://acme.example/jobs/1",
      source: "greenhouse",
      remote: true,
      applied: false,
      expired: false,
      location: null,
      country: null,
      postedAt: null,
    });
  });

  it("serializes dates as ISO strings and maps action=applied to applied:true", () => {
    const [record] = toMatchJson([
      scoredFixture({
        posting: { ...scoredFixture().posting, postedAt: new Date("2026-06-01T00:00:00.000Z") },
        action: "applied",
      }),
    ]);
    expect(record?.postedAt).toBe("2026-06-01T00:00:00.000Z");
    expect(record?.applied).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/json-output.test.ts`
Expected: FAIL — cannot resolve `./json-output`.

- [ ] **Step 3: Write minimal implementation**

Create `src/cli/json-output.ts`:

```ts
import type { ScoreOutcome } from "@app/matching/score-run";
import type { ScoredPosting } from "@app/storage/repository";
import { z } from "zod";

/** The stable `list --json` record shape — a flattened, JSON-safe view of a scored posting. */
export const MatchJsonSchema = z.object({
  score: z.number(),
  company: z.string(),
  title: z.string(),
  url: z.string(),
  source: z.string(),
  location: z.string().nullable(),
  remote: z.boolean(),
  country: z.string().nullable(),
  postedAt: z.string().nullable(),
  applied: z.boolean(),
  expired: z.boolean(),
});
export type MatchJson = z.infer<typeof MatchJsonSchema>;

/** Flatten `listScoredPostings` rows into the `list --json` array contract. */
export function toMatchJson(rows: ScoredPosting[]): MatchJson[] {
  return rows.map(({ posting, result, action, expired }) => ({
    score: result.score,
    company: posting.company,
    title: posting.title,
    url: posting.url,
    source: posting.source,
    location: posting.location ?? null,
    remote: posting.remote ?? false,
    country: posting.country ?? null,
    postedAt: posting.postedAt ? posting.postedAt.toISOString() : null,
    applied: action === "applied",
    expired,
  }));
}

/** `score --json` emits the run summary object as-is; this schema documents/validates its shape. */
export const ScoreOutcomeJsonSchema = z.object({
  counts: z.object({
    inDb: z.number(),
    afterRemote: z.number(),
    afterHeuristic: z.number(),
    afterCap: z.number(),
    alreadyScoredSkipped: z.number(),
    triageTitles: z.number(),
    deepScored: z.number(),
    remotePenalized: z.number(),
    locationPenalized: z.number(),
  }),
  estimate: z.record(z.string(), z.number()),
  warnings: z.array(z.object({ source: z.string(), message: z.string() }).loose()),
  abortedOnLimit: z.boolean(),
}) satisfies z.ZodType<unknown>;
```

Note: if `remote` in `ScoredPosting.posting` is already resolved to a definitive boolean by `listScoredPostings` (it is — see repository.ts), `posting.remote ?? false` preserves it; the `?? false` only guards the optional type, never overriding a real value.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/json-output.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS (verifies the schemas match the real `ScoreOutcome`/`ScoredPosting` types).

- [ ] **Step 5: Commit**

```bash
git add src/cli/json-output.ts src/cli/json-output.test.ts
git commit -m "feat(cli): add zod schemas and mapper for --json output"
```

---

### Task 4: Wire `list --json` + route list diagnostics to stderr (3.2/3.6)

**Files:**
- Modify: `src/cli/commands.ts` (`listMatches`)
- Modify: `src/cli/main.ts` (build diagnostics, pass json + diag into `listMatches`)
- Test: `src/cli/commands.test.ts` (append) — or `src/cli/main.test.ts` if list is tested there; check both and add where `listMatches` is already exercised.

**Interfaces:**
- `listMatches` signature gains options: `listMatches(repo, minScore, log, opts)` where `opts` now also carries `json?: boolean`. The "no matches" notice and any diagnostics go to a `diag` sink, not `log`, when in json mode. Keep `log` for the human table.

Design: `listMatches` prints EITHER the human table (via `log`) OR `JSON.stringify(toMatchJson(rows), null, 2)` via `log` (stdout) when `json`. The empty-state notice ("No matches yet…") must NOT pollute json stdout — in json mode an empty result prints `[]` to stdout; the human hint goes to `diag` (stderr). So `listMatches` needs the `diag` sink.

- [ ] **Step 1: Write the failing test**

Append to the file that tests `listMatches` (find it: `grep -rl "listMatches" src/cli/*.test.ts`). Add:

```ts
describe("listMatches --json", () => {
  it("prints a JSON array of match records to the log (stdout) and nothing human", () => {
    // Arrange a repo/fixture with one scored posting using the existing test helpers in this file.
    // (Reuse whatever in-memory Repository + seeding the surrounding tests already use.)
    const lines: string[] = [];
    const diagLines: string[] = [];
    listMatches(repo, 0, (m) => lines.push(m), {
      json: true,
      diag: (m) => diagLines.push(m),
    });
    const parsed = JSON.parse(lines.join("\n"));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toHaveProperty("score");
    expect(lines.join("\n")).not.toMatch(/\[/); // no ANSI on stdout
  });

  it("prints [] to stdout (not a human hint) when there are no matches in json mode", () => {
    const lines: string[] = [];
    listMatches(emptyRepo, 0, (m) => lines.push(m), { json: true, diag: () => {} });
    expect(JSON.parse(lines.join("\n"))).toEqual([]);
  });
});
```
(Adapt `repo`/`emptyRepo` to the file's existing fixtures — do not invent a new Repository harness if one exists.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run <that test file> -t "listMatches --json"`
Expected: FAIL — `listMatches` doesn't accept `json`/`diag` yet.

- [ ] **Step 3: Implement in `commands.ts`**

Update `listMatches` — extend its `opts` type with `json?: boolean; diag?: (message: string) => void;` and branch:

```ts
export function listMatches(
  repo: Repository,
  minScore: number,
  log: Logger,
  opts: {
    remoteOnly?: boolean;
    country?: string;
    includeApplied?: boolean;
    onlyApplied?: boolean;
    json?: boolean;
    diag?: (message: string) => void;
  } = {},
): void {
  const scored = repo.listScoredPostings(minScore, {
    remoteOnly: opts.remoteOnly,
    country: opts.country,
    includeApplied: opts.includeApplied,
    onlyApplied: opts.onlyApplied,
  });

  if (opts.json) {
    log(JSON.stringify(toMatchJson(scored), null, 2));
    return;
  }

  if (scored.length === 0) {
    (opts.diag ?? log)(style.dim("No matches yet. Run `job-hunter scan` first."));
    return;
  }
  for (const { posting, result } of scored) {
    log(
      `${scoreBadge(result.score)} ${style.bold(posting.title)} — ${posting.company}  ${style.url(posting.url)}`,
    );
  }
}
```
Add the import at the top of `commands.ts`: `import { toMatchJson } from "./json-output";`

- [ ] **Step 4: Wire it in `main.ts`**

Near the top of `main()`, after parsing, build the diagnostics sink once:
```ts
  const verbose = hasVerboseFlag(process.argv.slice(2));
  const jsonMode = "json" in command ? Boolean((command as { json?: boolean }).json) : false;
```
(Prefer a cleaner narrowing: check `command.kind === "list" || command.kind === "score"` then read `command.json` — avoid the `as`. Use:)
```ts
  const verbose = hasVerboseFlag(process.argv.slice(2));
  const jsonMode =
    command.kind === "list" || command.kind === "score" ? command.json : false;
  const diagnostics = createDiagnostics({ verbose, json: jsonMode });
```
Add imports: `import { createDiagnostics } from "./diagnostics";` and add `hasVerboseFlag` to the existing `./parse` import.

Update the `list` dispatch to pass json + diag:
```ts
      case "list":
        listMatches(repo, command.minScore, log, {
          remoteOnly: command.remoteOnly,
          country: command.country,
          includeApplied: command.includeApplied,
          onlyApplied: command.onlyApplied,
          json: command.json,
          diag: diagnostics.diag,
        });
        break;
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/cli`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands.ts src/cli/main.ts <the test file>
git commit -m "feat(cli): add list --json output on a clean stdout/stderr split"
```

---

### Task 5: Wire `score --json` + route scan/score diagnostics to stderr (3.2/3.6)

**Files:**
- Modify: `src/cli/main.ts` (`runScoreCommand`, `runScanCommand`, `score` dispatch)
- Test: `src/cli/main.test.ts` (append; this is where run*Command are tested — confirm with grep)

**Interfaces:**
- `runScoreCommand(repo, options, log, diagnostics)` — gains a `diagnostics: Diagnostics` param. In json mode it prints `JSON.stringify(outcome, null, 2)` to `log` (stdout) and routes the plan text + usage + warnings to `diagnostics.diag` (stderr). In human mode, warnings/usage move to `diagnostics.diag` too (they are diagnostics), the plan stays on `log`.
- `runScanCommand(repo, log, opts, diagnostics)` — progress (`onProgress`) and warnings route to `diagnostics.diag` instead of `log`. `scan` has no `--json`, but its progress belongs on stderr per 3.6.

- [ ] **Step 1: Write the failing test**

Append to `src/cli/main.test.ts` (reuse its existing `runScoreCommand` harness + fixtures):

```ts
describe("runScoreCommand --json", () => {
  it("prints the ScoreOutcome as JSON to stdout and routes warnings/plan to diag", async () => {
    const out: string[] = [];
    const diag: string[] = [];
    await runScoreCommand(repo, { minHeuristic: 0, limit: 10, rescore: false, dryRun: true, json: true }, (m) => out.push(m), {
      diag: (m) => diag.push(m),
      debug: () => {},
      isDebugEnabled: false,
    });
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed).toHaveProperty("counts");
    expect(parsed).toHaveProperty("abortedOnLimit");
    expect(out.join("\n")).not.toMatch(/\[/); // stdout is pure JSON, no ANSI
  });
});
```
(Adapt `repo`/fixtures + the `ScoreCliOptions` shape — note `ScoreCliOptions` must gain `json: boolean`; see Step 3.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/main.test.ts -t "runScoreCommand --json"`
Expected: FAIL — signature lacks diagnostics/json.

- [ ] **Step 3: Implement in `main.ts`**

Add `json: boolean;` to `ScoreCliOptions` (the type near the top of main.ts).

Change `runScoreCommand` to accept diagnostics and branch on json:
```ts
export async function runScoreCommand(
  repo: Repository,
  options: ScoreCliOptions,
  log: Logger,
  diagnostics: Diagnostics,
): Promise<void> {
  // ... unchanged setup through `outcome = await runScoreRun(...)` ...

  if (options.json) {
    log(JSON.stringify(outcome, null, 2));
  } else {
    log(formatScorePlan(outcome, { remoteOnly, limit: options.limit, dryRun: options.dryRun }));
    const usageSummary = formatUsageSummary(usage);
    if (usageSummary) diagnostics.diag(style.dim(usageSummary));
  }
  for (const warning of warnings) {
    diagnostics.diag(style.warn(`  ! [${warning.source}] ${warning.message}`));
  }
}
```
Note: the early "no profile"/"no key" guards currently use `log(style.warn(...))`. Move those warning lines to `diagnostics.diag(...)` too (they're diagnostics), but keep the `process.exitCode = 1` for the no-profile case. In json mode a failed precondition should still not print human text to stdout — diag (stderr) is correct.

Change `runScanCommand` to accept `diagnostics: Diagnostics` and route `onProgress` + warnings to `diagnostics.diag`:
```ts
      onProgress: (event) => diagnostics.diag(style.dim(formatProgress(event))),
```
and the trailing warning loop:
```ts
  for (const warning of result.warnings) {
    diagnostics.diag(style.warn(`  ! [${warning.source}] ${warning.message}`));
  }
```
Its "no profile" guard warning also moves to `diagnostics.diag`, keeping `process.exitCode = 1`.

Add `import type { Diagnostics } from "./diagnostics";` (Task 1 exports it).

Update dispatch in `main()`:
```ts
      case "scan":
        await runScanCommand(repo, log, { /* unchanged opts */ }, diagnostics);
        break;
      case "score":
        await runScoreCommand(
          repo,
          { /* unchanged */ json: command.json },
          log,
          diagnostics,
        );
        break;
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/cli`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/main.ts src/cli/main.test.ts
git commit -m "feat(cli): add score --json and route scan/score diagnostics to stderr"
```

---

### Task 6: Seed debug statements + document flags (6.3/3.2 docs)

**Files:**
- Modify: `src/cli/main.ts` and/or `src/cli/commands.ts` — a few `diagnostics.debug(ns, msg)` calls at pipeline boundaries.
- Modify: `src/cli/help.ts` — document `--json` and `--verbose`.
- Test: none new (debug lines are diagnostic-only; the sink is already tested in Task 1). Typecheck covers wiring.

- [ ] **Step 1: Seed debug statements**

Add a handful of `diagnostics.debug("scan"|"score", ...)` calls at real boundaries in `main.ts`, e.g.:
- In `runScanCommand`, before `runScan`: `diagnostics.debug("scan", \`scope=${scanScope} tracked=${trackedCompanies.length}\`);`
- After `runScan`: `diagnostics.debug("scan", \`warnings=${result.warnings.length}\`);`
- In `runScoreCommand`, after resolving provider: `diagnostics.debug("score", \`provider=${provider.name ?? "?"} model=${model}\`);` (use fields that exist — verify `provider` shape; if `name` isn't present, use `\`model=${model}\``).
- After `runScoreRun`: `diagnostics.debug("score", \`deepScored=${outcome.counts.deepScored} aborted=${outcome.abortedOnLimit}\`);`

Keep them terse and factual. Do not add debug lines inside hot loops.

- [ ] **Step 2: Document in help.ts**

- `list` invocation: append `[--json]`; add an option row `["--json", "Output matches as a JSON array (machine-readable; diagnostics go to stderr)."]`.
- `score` invocation: append `[--json]`; add an option row `["--json", "Output the score run summary as JSON (machine-readable)."]`.
- Add a global note about `--verbose` — either as an OPTIONS row in the general help (where `-h`/`-v` are documented) or on each command. Simplest: add a line to the global options section: `["--verbose", "Verbose diagnostic logging to stderr (also enabled by DEBUG=job-hunter*)."]`. Match the existing global-options rendering.

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm run cli -- list --help` and `npm run cli -- score --help`
Expected: `--json` documented; `--verbose` visible in help.
Run: `npm run cli -- list --json` (on an empty dev DB) → prints `[]` to stdout.
Run: `npm run cli -- list --json --verbose` → `[]` on stdout, any debug/diag on stderr (`... --json 2>/dev/null` still yields clean `[]`).

- [ ] **Step 4: Commit**

```bash
git add src/cli/main.ts src/cli/commands.ts src/cli/help.ts
git commit -m "feat(cli): seed debug logging and document --json/--verbose"
```

---

### Task 7: Update audit report + full CI-gate verification

**Files:**
- Modify: `_reports/audit/cli-best-practices-2026-07-10.md`

- [ ] **Step 1: Mark shipped gaps**

Record that 3.2, 6.3, and 3.6 shipped in PR B (referencing this plan) in the audit report's gap table.

- [ ] **Step 2: Full CI-equivalent gate**

Run each; STOP and report BLOCKED on any failure (a `npm run lint:fix` formatting fix + re-`lint` is fine):
- `npm run lint`
- `npm run typecheck`
- `npm run typecheck:web`
- `npm run test:coverage` (gate 93/85/90/93)
- `npm run test:web`
- `npm run build:web`

- [ ] **Step 3: Manual smoke — verify the core promise (clean JSON on stdout)**

Run: `npm run cli -- list --json 2>/dev/null` → output is valid JSON (pipe to `node -e "JSON.parse(require('fs').readFileSync(0))"` or `jq .` if available) with NO diagnostic text.
Run: `npm run cli -- list --json --verbose 2>/dev/null` → still clean JSON (diagnostics suppressed to /dev/null).
Do NOT run `serve`.

- [ ] **Step 4: Commit**

```bash
git add _reports/audit/cli-best-practices-2026-07-10.md
git commit -m "docs(cli): record PR B output/observability fixes in the audit report"
```

---

## Self-Review

**Spec coverage:** 3.6 diagnostic sink → Task 1; `--json`/`--verbose` parsing → Task 2; JSON schemas/mapper → Task 3; `list --json` + list diagnostics → Task 4; `score --json` + scan/score diagnostics → Task 5; debug seeding + help docs → Task 6; report + gate → Task 7. The spec's PR-B scope (3.2, 6.3, 3.6) is fully covered. The score-summary refinement (score emits an object, not an array) is reflected in Task 3/5 and the updated spec.

**Placeholder scan:** Every code step shows the code. Two steps deliberately say "adapt to the file's existing fixtures" (Task 4/5 tests) — this is a real instruction (reuse the existing Repository test harness rather than inventing one), not a placeholder; the assertions themselves are fully specified. The implementer must grep for the existing test harness first.

**Type consistency:** `Diagnostics` shape (`diag`/`debug`/`isDebugEnabled`) is identical across Tasks 1, 4, 5. `createDiagnostics`/`hasVerboseFlag`/`debugEnabledFromEnv`/`toMatchJson`/`MatchJsonSchema` names match between definition and use. `ScoreCliOptions` gains `json` (Task 5) consistent with the `score` Command variant gaining `json` (Task 2). `listMatches` opts extension is consistent between Task 4's impl and test.

**Constraint adherence:** zod reused (no new dep); no `!`; `--json` stdout kept pure (empty → `[]`, diagnostics to stderr); tests validate against the schema + fixtures, not duplicated literals.

**Known risk flagged for review:** Task 2's `--verbose` filtering approach (strip before per-command parse) vs. adding `verbose` to every options block — the plan picks the filter as the single-point solution and says so; the reviewer should confirm the help/version scans still see the original argv (they do — they run before the filter).

# CLI Best-Practices — PR A (Quick Wins) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the four low-risk CLI best-practice fixes — `engines.node` + runtime guard (4.3), short flag aliases (1.1), bug-report path (6.5), and the argument-injection audit (10.1) — as one themed PR.

**Architecture:** Purely additive changes to the existing hand-rolled `parseArgs`-based CLI. Short aliases use `parseArgs`'s native `short` option field. The runtime guard and bug-report line are small additions to `src/cli/main.ts`. The 10.1 task is an audit with a regression test, not a code change (the `service` spawn is already array-form with a fixed-enum action).

**Tech Stack:** TypeScript-strict ESM, `node:util` `parseArgs`, vitest (colocated offline tests), Biome.

## Global Constraints

- Node `>=22` is the supported floor (documented in `CLAUDE.md` as "Node 24; 22+ required").
- TypeScript-strict; `noUncheckedIndexedAccess` on. NO `!` non-null assertions. Avoid type assertions outside tests.
- No new runtime dependencies in this PR.
- Biome: 2-space indent, 100-col width, double quotes. Run `npm run lint:fix` before committing.
- Conventional Commits. Do NOT add a Claude co-author footer.
- Tests colocated (`*.test.ts` next to source), offline, deterministic. Do not hard-code values in `expect` that duplicate a magic literal already under test — assert against the imported constant where one exists.
- Coverage gate must stay green: statements 93 / branches 85 / functions 90 / lines 93.
- Failures degrade, never crash — do not introduce a code path that aborts on a recoverable condition.

## File Structure

- `package.json` — add `engines` field. (Modify)
- `src/runtime/node-version.ts` — NEW: pure `checkNodeVersion` helper (parse major, compare to floor, return a friendly message or `null`). Kept separate from `main.ts` so it is unit-testable without invoking `main`.
- `src/runtime/node-version.test.ts` — NEW: tests for the helper.
- `src/cli/main.ts` — call the guard early; append bug-report line in the crash handler. (Modify)
- `src/cli/parse.ts` — add `short` aliases to the relevant `options` blocks. (Modify)
- `src/cli/parse.test.ts` — add alias-resolution tests (file exists; append). 
- `src/cli/help.ts` — document aliases in the affected commands' `options`/`invocation`. (Modify)
- `src/cli/service.test.ts` — add the 10.1 regression test (file exists; append).
- `.github/ISSUE_TEMPLATE/bug_report.md` — NEW: bug report template.
- `_reports/audit/cli-best-practices-2026-07-10.md` — update gap table statuses at the end. (Modify)

---

### Task 1: `engines.node` field + runtime guard (4.3)

**Files:**
- Modify: `package.json`
- Create: `src/runtime/node-version.ts`
- Test: `src/runtime/node-version.test.ts`
- Modify: `src/cli/main.ts:219-221` (early in `main`)

**Interfaces:**
- Produces: `checkNodeVersion(versionString: string, floorMajor?: number): string | null` — returns a friendly warning message if the running major is below the floor, else `null`. `floorMajor` defaults to `22`.

- [ ] **Step 1: Write the failing test**

Create `src/runtime/node-version.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkNodeVersion, NODE_VERSION_FLOOR } from "./node-version";

describe("checkNodeVersion", () => {
  it("returns null when the running major meets the floor", () => {
    expect(checkNodeVersion(`${NODE_VERSION_FLOOR}.4.0`)).toBeNull();
    expect(checkNodeVersion(`${NODE_VERSION_FLOOR + 2}.0.0`)).toBeNull();
  });

  it("returns a message naming the floor when the running major is below it", () => {
    const message = checkNodeVersion(`${NODE_VERSION_FLOOR - 1}.9.0`);
    expect(message).not.toBeNull();
    expect(message).toContain(String(NODE_VERSION_FLOOR));
  });

  it("returns null for an unparseable version rather than warning spuriously", () => {
    expect(checkNodeVersion("not-a-version")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/runtime/node-version.test.ts`
Expected: FAIL — cannot resolve `./node-version`.

- [ ] **Step 3: Write minimal implementation**

Create `src/runtime/node-version.ts`:

```ts
/** Minimum Node.js major version the CLI supports (mirrors package.json `engines.node`). */
export const NODE_VERSION_FLOOR = 22;

/**
 * Compare a Node.js version string (e.g. `process.versions.node`) against the supported floor.
 * Returns a friendly, actionable warning when the running major is below the floor, else `null`.
 * An unparseable input returns `null` — a guard should never crash or warn on garbage input.
 */
export function checkNodeVersion(
  versionString: string,
  floorMajor: number = NODE_VERSION_FLOOR,
): string | null {
  const major = Number.parseInt(versionString.split(".")[0] ?? "", 10);
  if (!Number.isInteger(major)) return null;
  if (major >= floorMajor) return null;
  return `job-hunter needs Node ${floorMajor} or newer (you have ${versionString}). Some features may not work; see .nvmrc.`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/runtime/node-version.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the guard into `main` and add the `engines` field**

In `src/cli/main.ts`, add the import alongside the other `@app/runtime/*` imports:

```ts
import { checkNodeVersion } from "@app/runtime/node-version";
```

Then at the very start of `main()` (immediately after `export async function main(): Promise<void> {`, before `const command = parseCli(...)`):

```ts
  const versionWarning = checkNodeVersion(process.versions.node);
  if (versionWarning) console.error(style.warn(versionWarning));
```

In `package.json`, add after the `"bin"` block (keep valid JSON — comma placement):

```json
  "engines": {
    "node": ">=22"
  },
```

- [ ] **Step 6: Verify typecheck + full suite**

Run: `npm run typecheck`
Expected: PASS.
Run: `npx vitest run src/runtime/node-version.test.ts src/cli`
Expected: PASS (guard fires to stderr, no test regressions).

- [ ] **Step 7: Commit**

```bash
git add package.json src/runtime/node-version.ts src/runtime/node-version.test.ts src/cli/main.ts
git commit -m "feat(cli): enforce Node 22+ via engines field and friendly runtime guard"
```

---

### Task 2: Short flag aliases (1.1)

**Files:**
- Modify: `src/cli/parse.ts` (add `short` to option definitions)
- Test: `src/cli/parse.test.ts` (append)
- Modify: `src/cli/help.ts` (document aliases)

**Interfaces:**
- Consumes: existing `parseCli(argv: string[]): Command` from `src/cli/parse.ts`.
- Produces: no signature change — `parseCli` now also accepts `-p`/`-n`/`-l`/`-a` as aliases.

Aliases added (all additive; long forms unchanged):
- `serve`: `-p` → `--port`
- `track add`: `-n` → `--name`
- `score`: `-l` → `--limit`
- `scan`: `-a` → `--all`

- [ ] **Step 1: Write the failing tests**

Append to `src/cli/parse.test.ts`:

```ts
describe("short flag aliases", () => {
  it("accepts -p as an alias for --port on serve", () => {
    expect(parseCli(["serve", "-p", "3000"])).toMatchObject({ kind: "serve", port: 3000 });
  });

  it("accepts -a as an alias for --all on scan", () => {
    expect(parseCli(["scan", "-a"])).toMatchObject({ kind: "scan", all: true });
  });

  it("accepts -l as an alias for --limit on score", () => {
    expect(parseCli(["score", "-l", "5"])).toMatchObject({ kind: "score", limit: 5 });
  });

  it("accepts -n as an alias for --name on track add", () => {
    expect(parseCli(["track", "add", "https://x.com/careers", "-n", "Acme"])).toMatchObject({
      kind: "track-add",
      url: "https://x.com/careers",
      name: "Acme",
    });
  });
});
```

Note: `parse.test.ts` already imports `parseCli` and uses `describe`/`it`/`expect`; reuse the existing imports — do not re-import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/cli/parse.test.ts -t "short flag aliases"`
Expected: FAIL — `-p`/`-a`/`-l`/`-n` currently error as unknown options (routed to `{ kind: "help", error }`).

- [ ] **Step 3: Add the `short` fields in `parse.ts`**

In the `serve` case options (`src/cli/parse.ts:123-127`), change the `port` line:

```ts
          port: { type: "string", short: "p" },
```

In the `scan` case options (`:94-98`), change the `all` line:

```ts
          all: { type: "boolean", short: "a" },
```

In the `score` case options (`:215-222`), change the `limit` line:

```ts
          limit: { type: "string", short: "l" },
```

In the `track add` case options (`:190-194`), change the `name` line:

```ts
          options: { name: { type: "string", short: "n" } },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/parse.test.ts -t "short flag aliases"`
Expected: PASS (4 tests).

- [ ] **Step 5: Document the aliases in `help.ts`**

Update the affected `invocation` strings and option rows in `COMMANDS` (`src/cli/help.ts`) so help reflects the aliases:

- `scan` invocation → `"scan [--retry-failed] [-a|--all] [--freshness-hours N]"`; change the `--all` option token to `"-a, --all"`.
- `score` invocation → replace `[--limit N]` with `[-l|--limit N]`; change the `--limit N` option token to `"-l, --limit N"`.
- `serve` invocation → prefix port with `-p` (change `[--port N]` to `[-p|--port N]`); change its `--port N` option token to `"-p, --port N"`.
- `track` (add) — in its option/subcommand rows, change the `--name` token to `"-n, --name <name>"`.

(Match each command's existing row format exactly; only the token text changes.)

- [ ] **Step 6: Verify help renders and suite is green**

Run: `npm run cli -- scan --help`
Expected: output shows `-a, --all`.
Run: `npx vitest run src/cli`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/parse.ts src/cli/parse.test.ts src/cli/help.ts
git commit -m "feat(cli): add short flag aliases -p/-n/-l/-a"
```

---

### Task 3: Bug-report path (6.5)

**Files:**
- Modify: `src/cli/main.ts:311-314` (top-level crash handler)
- Create: `.github/ISSUE_TEMPLATE/bug_report.md`

**Interfaces:**
- Produces: on an uncaught top-level error, the CLI prints a stderr line pointing at the issues page.

The issues URL is `https://github.com/jdelgadoperez/job-hunter/issues/new`.

- [ ] **Step 1: Add the bug-report line to the crash handler**

In `src/cli/main.ts`, change the bottom `main().catch(...)` block to:

```ts
  main().catch((error) => {
    console.error(style.error(String(error)));
    console.error(
      style.dim("Report this: https://github.com/jdelgadoperez/job-hunter/issues/new"),
    );
    process.exitCode = 1;
  });
```

- [ ] **Step 2: Create the issue template**

Create `.github/ISSUE_TEMPLATE/bug_report.md`:

```markdown
---
name: Bug report
about: Report a problem with the job-hunter CLI
title: ""
labels: bug
---

**What happened**
A clear description of the bug.

**Command run**
The exact `job-hunter ...` command.

**Expected vs actual**
What you expected, and what happened instead.

**Environment**
- `job-hunter --version`:
- OS:
- Node version (`node --version`):

**Logs**
Re-run with `--verbose` and paste relevant output (redact anything sensitive).
```

> Note: `--verbose` is delivered in PR B. The template references it because the template lands once and PR B follows; the reference is forward-compatible and harmless before then.

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS. (The crash handler only runs as the process entrypoint, so no unit test asserts it; `String(error)` + a static string are trivially correct and covered by the existing top-level guard.)

- [ ] **Step 4: Commit**

```bash
git add src/cli/main.ts .github/ISSUE_TEMPLATE/bug_report.md
git commit -m "feat(cli): surface a bug-report URL on crash and add issue template"
```

---

### Task 4: Argument-injection audit + regression test (10.1)

**Files:**
- Test: `src/cli/service.test.ts` (append)
- (No production change expected — `runServiceCommand` already spawns array-form args with a fixed-enum action.)

**Interfaces:**
- Consumes: `resolveServiceInvocation(action, platform, repoRoot)` and `SERVICE_ACTIONS` / `isServiceAction` from `src/cli/service.ts`.

**Audit finding to encode:** the only user-influenced value reaching a child process is the `service` action, which `parseCli` constrains to `SERVICE_ACTIONS` via `isServiceAction` before dispatch, and `spawn` receives `(command, argsArray)` — never a concatenated shell string. The test locks in both invariants so a future refactor can't regress into shell interpolation.

- [ ] **Step 1: Write the regression test**

Append to `src/cli/service.test.ts` (reuse existing imports; add any missing symbols to the existing import from `./service`):

```ts
describe("service argument-injection invariants (10.1)", () => {
  it("rejects any action outside the fixed allow-list before it reaches spawn", () => {
    expect(isServiceAction("install; rm -rf /")).toBe(false);
    expect(isServiceAction("--version")).toBe(false);
    for (const action of SERVICE_ACTIONS) {
      expect(isServiceAction(action)).toBe(true);
    }
  });

  it("passes the script path as an array arg, never a shell string, on posix", () => {
    const invocation = resolveServiceInvocation("start", "linux", "/repo");
    expect(Array.isArray(invocation.args)).toBe(true);
    expect(invocation.command).toContain("service-start.sh");
    expect(invocation.command).not.toContain(" ");
  });

  it("passes the script via -File as a discrete arg on win32", () => {
    const invocation = resolveServiceInvocation("stop", "win32", "C:/repo");
    expect(invocation.command).toBe("powershell");
    expect(invocation.args).toContain("-File");
    const fileIndex = invocation.args.indexOf("-File");
    expect(invocation.args[fileIndex + 1]).toContain("service-stop.ps1");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/cli/service.test.ts -t "argument-injection"`
Expected: PASS immediately (no production change needed — this documents existing safe behavior).

- [ ] **Step 3: If it fails, stop and reassess**

Expected: it passes. If it does NOT, a real injection hole exists — do not paper over it; surface the finding and design a fix before proceeding (array-form spawn + `--` separator per rubric 10.1).

- [ ] **Step 4: Commit**

```bash
git add src/cli/service.test.ts
git commit -m "test(cli): lock in service argument-injection invariants"
```

---

### Task 5: Update the audit report + final verification

**Files:**
- Modify: `_reports/audit/cli-best-practices-2026-07-10.md`

- [ ] **Step 1: Mark shipped gaps in the audit report**

In the "Gaps accepted for implementation" table, append a `Status` note (or a short "PR A shipped" line beneath the table) recording that 4.3, 1.1, 6.5, and 10.1 are done, referencing this plan.

- [ ] **Step 2: Full CI-equivalent verification**

Run: `npm run lint`
Expected: PASS (run `npm run lint:fix` first if formatting drifts).
Run: `npm run typecheck`
Expected: PASS.
Run: `npm run test:coverage`
Expected: PASS with coverage gate green (stmts 93 / branches 85 / funcs 90 / lines 93).

- [ ] **Step 3: Manual smoke**

Run: `npm run cli -- serve -p 3000 --no-open` (Ctrl+C to stop) — confirms `-p` works.
Run: `npm run cli -- score --help` — confirms `-l, --limit` documented.

- [ ] **Step 4: Commit**

```bash
git add _reports/audit/cli-best-practices-2026-07-10.md
git commit -m "docs(cli): record PR A best-practice fixes in the audit report"
```

---

## Self-Review

**Spec coverage:** PR A's four items each map to a task — 4.3 → Task 1, 1.1 → Task 2, 6.5 → Task 3, 10.1 → Task 4, plus Task 5 for report update + CI gate. No PR A requirement is unaddressed. (PR B/C items are intentionally out of scope for this plan.)

**Placeholder scan:** No TBD/TODO/"handle edge cases" — every code step shows the exact code. The one forward-reference (`--verbose` in the issue template) is explicitly annotated as intentional and harmless.

**Type consistency:** `checkNodeVersion` / `NODE_VERSION_FLOOR` names match between the helper, its test, and the `main.ts` call site. `resolveServiceInvocation` / `isServiceAction` / `SERVICE_ACTIONS` match `service.ts` exactly. `parseCli` signature unchanged. Alias `short` keys (`p`/`a`/`l`/`n`) are single characters as `parseArgs` requires.

**Constraint adherence:** No new deps; no `!` assertions; tests assert against imported constants (`NODE_VERSION_FLOOR`, `SERVICE_ACTIONS`) rather than duplicated literals where one exists.

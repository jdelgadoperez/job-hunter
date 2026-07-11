# CLI Lifecycle C1 — SIGINT/SIGTERM Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Handle `SIGINT`/`SIGTERM` gracefully — `serve` closes its listener + scheduler and exits 0; `scan` closes its persistent Chromium (no orphan) and exits 130 — via a shared, idempotent, unit-testable shutdown helper.

**Architecture:** A tiny `onShutdown(handler, target = process)` helper registers a one-shot handler for both signals on an **injectable** `SignalTarget` (defaults to `process`, so tests pass a fake `EventEmitter` and never signal the vitest process). `serve` uses it to `clearInterval` its refresh timer + `server.close()` (exit 0 via natural loop drain). `scan` uses it to `await renderer.dispose()` + `process.exit(130)`, deregistering on normal completion so the handler never leaks into a later command.

**Tech Stack:** TypeScript-strict ESM, `node:events`/`process` signals, `@hono/node-server` (`serve()` return has `.on`/`.close`), Playwright (`PlaywrightRenderer.dispose()`), vitest.

## Global Constraints

- TypeScript-strict, ESM, `@app/*` alias (→ `src/*`). `noUncheckedIndexedAccess` + `noImplicitOverride` on.
- NO `!` non-null assertions. Avoid type assertions outside tests — the `SignalTarget` seam is designed so no `as` is needed at the `process` default or the test emitter.
- No new runtime dependencies.
- Biome: 2-space indent, 100-col width, double quotes. Run `npm run lint:fix` before committing.
- Conventional Commits. **NO Claude co-author footer.**
- Tests colocated (`*.test.ts` next to source), offline, deterministic. Never actually signal the test process — use the injectable `SignalTarget`.
- Coverage gate stays green: statements 93 / branches 85 / functions 90 / lines 93.
- **Degrade-not-crash / no happy-path change:** a scan/serve never signalled must behave exactly as today (handler dormant; `scan` deregisters on completion).
- The repo convention is `process.exitCode`, never `process.exit()` — the ONE justified exception is `scan`'s signal handler (exit 130 while an in-flight `await` hangs); document it inline.

## File Structure

- `src/cli/signals.ts` — NEW: `SignalTarget` type + `onShutdown` helper. One responsibility: signal registration + idempotency + cleanup. Consumed by both `serve` and `scan`.
- `src/cli/signals.test.ts` — NEW.
- `src/server/serve.ts` — MODIFY: `scheduleRefresh` returns its timer; `startServer` gains a `signals` param and registers the shutdown handler via a small pure `registerServerShutdown` (extracted so it's testable without binding a real port — `startServer` itself is not unit-tested today).
- `src/server/serve.ts` also hosts the exported pure `registerServerShutdown({ server, timer, signals })`.
- `src/server/serve-shutdown.test.ts` — NEW (tests the pure `registerServerShutdown`).
- `src/cli/main.ts` — MODIFY: `runScanCommand` lifts the renderer to a local, gains a `signals` param, registers the exit-130 handler, deregisters in a `finally`.
- `src/cli/main.test.ts` — MODIFY: scan-shutdown tests.
- `_reports/audit/cli-best-practices-2026-07-10.md` — MODIFY: mark 1.8 shipped (C1).

## Interfaces (locked signatures used across tasks)

- `type SignalTarget = { on(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown; off(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown };` — satisfied by both `process` and a `node:events` `EventEmitter`. (Verify it typechecks against `process` with no `as`; both `process.on`/`process.off` accept a `NodeJS.Signals` string which is a supertype — if strict assignability complains, widen the param to `NodeJS.Signals` in the type and keep passing only the two literals. The implementer resolves this at Task 1 typecheck.)
- `onShutdown(handler: (signal: "SIGINT" | "SIGTERM") => void, target?: SignalTarget): () => void` — registers `handler` for both signals on `target` (default `process`); runs at most once (idempotent); returns a `dispose()` that removes both listeners.
- `registerServerShutdown(deps: { server: { close(): void }; timer: NodeJS.Timeout | undefined; signals?: SignalTarget }): () => void` — wires an `onShutdown` that `clearInterval(timer)` (when present) + `server.close()` + `process.exitCode = 0`. Returns the `dispose()` from `onShutdown`.
- `scheduleRefresh(...)` return type changes from `void` to `NodeJS.Timeout | undefined`.
- `startServer(opts?: ServeOptions, signals?: SignalTarget): void` — unchanged behavior + registers server shutdown.
- `runScanCommand(repo, log, opts, diagnostics, signals?: SignalTarget): Promise<void>` — `signals` appended (default `process`); registers/deregisters the scan shutdown handler.

---

### Task 1: The `onShutdown` helper + `SignalTarget`

**Files:**
- Create: `src/cli/signals.ts`
- Test: `src/cli/signals.test.ts`

**Interfaces:**
- Produces: `SignalTarget`, `onShutdown` (signatures above).

- [ ] **Step 1: Write the failing test**

Create `src/cli/signals.test.ts`:

```ts
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { onShutdown, type SignalTarget } from "./signals";

/** An EventEmitter typed as the SignalTarget seam — the same shape production passes `process` for. */
function fakeTarget(): EventEmitter & SignalTarget {
  return new EventEmitter();
}

describe("onShutdown", () => {
  it("runs the handler once per process, ignoring a second signal (idempotent)", () => {
    const target = fakeTarget();
    const handler = vi.fn();
    onShutdown(handler, target);

    target.emit("SIGINT");
    target.emit("SIGINT");
    target.emit("SIGTERM");

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("registers both SIGINT and SIGTERM (SIGTERM alone triggers it)", () => {
    const target = fakeTarget();
    const handler = vi.fn();
    onShutdown(handler, target);

    target.emit("SIGTERM");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("SIGTERM");
  });

  it("dispose() removes both listeners so later signals do nothing", () => {
    const target = fakeTarget();
    const handler = vi.fn();
    const dispose = onShutdown(handler, target);

    dispose();
    target.emit("SIGINT");
    target.emit("SIGTERM");

    expect(handler).not.toHaveBeenCalled();
    expect(target.listenerCount("SIGINT")).toBe(0);
    expect(target.listenerCount("SIGTERM")).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/signals.test.ts`
Expected: FAIL — cannot resolve `./signals`.

- [ ] **Step 3: Write the implementation**

Create `src/cli/signals.ts`:

```ts
/** The subset of `process` (and a test `EventEmitter`) that signal registration needs. */
export type SignalTarget = {
  on(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown;
};

const SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * Register a one-shot shutdown handler for SIGINT + SIGTERM on `target` (defaults to `process`).
 * The handler fires at most once — a second Ctrl+C while shutting down is ignored. Returns a
 * `dispose()` that removes both listeners, so a one-shot command can deregister on normal completion
 * and never leak a handler into a later command sharing the same process.
 */
export function onShutdown(
  handler: (signal: "SIGINT" | "SIGTERM") => void,
  target: SignalTarget = process,
): () => void {
  let firing = false;
  const listeners = SIGNALS.map((signal) => {
    const listener = () => {
      if (firing) return;
      firing = true;
      handler(signal);
    };
    target.on(signal, listener);
    return { signal, listener } as const;
  });

  return () => {
    for (const { signal, listener } of listeners) target.off(signal, listener);
  };
}
```

Note on the `SignalTarget` default: if `target: SignalTarget = process` triggers a strict
assignability error (because `process.on` is typed over the wider `NodeJS.Signals`), widen the type's
signal params to `NodeJS.Signals` and keep the `SIGNALS` literal array — do NOT add an `as` cast.
Confirm with the typecheck in Step 5.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/signals.test.ts`
Expected: PASS (all 3).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS. If the `= process` default errored, apply the `NodeJS.Signals` widening noted in
Step 3 and re-run until clean — no `as` casts.

- [ ] **Step 6: Commit**

```bash
git add src/cli/signals.ts src/cli/signals.test.ts
git commit -m "feat(cli): add one-shot SIGINT/SIGTERM shutdown helper"
```

---

### Task 2: `serve` graceful shutdown

**Files:**
- Modify: `src/server/serve.ts` (`scheduleRefresh` returns its timer; add pure `registerServerShutdown`; call it from `startServer`)
- Test: `src/server/serve-shutdown.test.ts` (NEW — tests the pure `registerServerShutdown`)

**Interfaces:**
- Consumes: `onShutdown`, `SignalTarget` from `./` (Task 1). Import path from `src/server/` is `../cli/signals`.
- Produces: `registerServerShutdown(deps)`, `scheduleRefresh` now returns `NodeJS.Timeout | undefined`, `startServer(opts?, signals?)`.

Design: `startServer` binds a real port, so it isn't unit-tested today. Extract the wiring into a
pure `registerServerShutdown({ server, timer, signals })` that takes already-created resources — this
is what the test drives with fakes. `startServer` just constructs the resources and calls it.

- [ ] **Step 1: Write the failing test**

Create `src/server/serve-shutdown.test.ts`:

```ts
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { SignalTarget } from "../cli/signals";
import { registerServerShutdown } from "./serve";

function fakeTarget(): EventEmitter & SignalTarget {
  return new EventEmitter();
}

describe("registerServerShutdown", () => {
  it("on SIGINT closes the server, clears the timer, and sets exitCode 0", () => {
    const target = fakeTarget();
    const server = { close: vi.fn() };
    const timer = setInterval(() => {}, 1_000_000);
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    process.exitCode = 7; // prove the handler sets it to 0

    registerServerShutdown({ server, timer, signals: target });
    target.emit("SIGINT");

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledWith(timer);
    expect(process.exitCode).toBe(0);

    clearInterval(timer);
    clearSpy.mockRestore();
    process.exitCode = 0;
  });

  it("tolerates an absent timer (scheduler disabled)", () => {
    const target = fakeTarget();
    const server = { close: vi.fn() };

    registerServerShutdown({ server, timer: undefined, signals: target });
    target.emit("SIGTERM");

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
    process.exitCode = 0;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/serve-shutdown.test.ts`
Expected: FAIL — `registerServerShutdown` is not exported from `./serve`.

- [ ] **Step 3: Implement in `serve.ts`**

Add the import near the other local imports (after `import { classifyListenError } from "./listen-error";`):

```ts
import { onShutdown, type SignalTarget } from "../cli/signals";
```

Add the exported pure function (place it just above `startServer`):

```ts
/**
 * Wire graceful shutdown for the running dashboard: on SIGINT/SIGTERM, stop the refresh scheduler and
 * close the listener, then let the event loop drain and exit 0 (no `process.exit` — the repo never
 * force-exits). Pure over its injected resources so it unit-tests without binding a real port.
 */
export function registerServerShutdown(deps: {
  server: { close(): void };
  timer: NodeJS.Timeout | undefined;
  signals?: SignalTarget;
}): () => void {
  return onShutdown(() => {
    if (deps.timer) clearInterval(deps.timer);
    deps.server.close();
    process.exitCode = 0;
  }, deps.signals);
}
```

Change `scheduleRefresh` to return its timer. Current signature ends `): void {` and the body creates
`const timer = setInterval(...)`, calls `timer.unref()`, logs, and returns nothing. Update:
- Change the return type `): void {` → `): NodeJS.Timeout | undefined {`.
- The existing early return for a disabled interval (`if (!Number.isFinite(hours) || hours <= 0) return;`) becomes `return undefined;`.
- At the end of the function (after the `console.log(...)` auto-refresh line), add `return timer;`.

In `startServer`, capture the timer and register shutdown. The current code is:
```ts
  scheduleRefresh(jobs, runScanForScope, opts.refreshHours ?? DEFAULT_REFRESH_HOURS);
```
Replace with:
```ts
  const refreshTimer = scheduleRefresh(jobs, runScanForScope, opts.refreshHours ?? DEFAULT_REFRESH_HOURS);
  registerServerShutdown({ server, timer: refreshTimer, signals });
```
And change the signature:
```ts
export function startServer(opts: ServeOptions = {}, signals: SignalTarget = process): void {
```
(`server` is already in scope in `startServer` — it's the `serve(...)` return used by the existing
`server.on("error", ...)`. Ensure `registerServerShutdown` is called AFTER `server` is assigned.)

- [ ] **Step 4: Run the test + typecheck**

Run: `npx vitest run src/server/serve-shutdown.test.ts`
Expected: PASS (both).
Run: `npx vitest run src/server`
Expected: PASS (existing serve/app/job tests unaffected).
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/serve.ts src/server/serve-shutdown.test.ts
git commit -m "feat(cli): close the dashboard listener and scheduler on SIGINT/SIGTERM"
```

---

### Task 3: `scan` clean-exit (no orphaned browser, exit 130)

**Files:**
- Modify: `src/cli/main.ts` (`runScanCommand`: lift renderer, add `signals` param, register + deregister handler)
- Test: `src/cli/main.test.ts` (append scan-shutdown tests)

**Interfaces:**
- Consumes: `onShutdown`, `SignalTarget` from `./signals` (Task 1).
- Produces: `runScanCommand(repo, log, opts, diagnostics, signals?: SignalTarget)`.

Design: `runScanCommand` builds `new PlaywrightRenderer()` inline (`main.ts:121`). Lift it to a local
so the signal handler can dispose it. Register the handler before `runScan`; deregister in a `finally`
so it never leaks into a later in-process command (tests, serve's background scans).

- [ ] **Step 1: Write the failing test**

Append to `src/cli/main.test.ts`. This file already mocks discovery (`@app/discovery/discover`) so
`scan` runs offline, and has the `seedProfile()` helper in the `scan command` describe. The scan uses
a real `PlaywrightRenderer`, but discovery is mocked so its browser is never launched — meaning
`dispose()` is a safe no-op call we can still spy on via the prototype. Add a new describe:

```ts
import { PlaywrightRenderer } from "@app/net/playwright-renderer";
import { EventEmitter } from "node:events";
import { runScanCommand } from "./main";
import { createDiagnostics } from "./diagnostics";
import type { SignalTarget } from "./signals";

describe("scan command signal handling", () => {
  function seedProfileForScan(): void {
    const repo = openDb();
    repo.saveProfile(profile);
    repo.close();
  }

  function fakeSignals(): EventEmitter & SignalTarget {
    return new EventEmitter();
  }

  it("disposes the Playwright renderer and exits 130 on SIGINT", async () => {
    seedProfileForScan();
    h.postings = [posting("1")];
    const signals = fakeSignals();
    const disposeSpy = vi
      .spyOn(PlaywrightRenderer.prototype, "dispose")
      .mockResolvedValue(undefined);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const repo = openDb();
    const diagnostics = createDiagnostics({ verbose: false, json: false }, () => {});

    await runScanCommand(repo, () => {}, { retryFailed: false, all: false }, diagnostics, signals);
    signals.emit("SIGINT");

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(130);

    repo.close();
    disposeSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("removes the signal handler after a normal scan (no leak)", async () => {
    seedProfileForScan();
    h.postings = [posting("1")];
    const signals = fakeSignals();
    const disposeSpy = vi
      .spyOn(PlaywrightRenderer.prototype, "dispose")
      .mockResolvedValue(undefined);
    const repo = openDb();
    const diagnostics = createDiagnostics({ verbose: false, json: false }, () => {});

    await runScanCommand(repo, () => {}, { retryFailed: false, all: false }, diagnostics, signals);
    disposeSpy.mockClear(); // ignore the normal end-of-discovery dispose
    signals.emit("SIGINT"); // handler should be gone

    expect(disposeSpy).not.toHaveBeenCalled();
    expect(signals.listenerCount("SIGINT")).toBe(0);

    repo.close();
    disposeSpy.mockRestore();
  });
});
```

Note: put the three new top-of-file imports (`PlaywrightRenderer`, `EventEmitter`, `SignalTarget`,
plus `runScanCommand`/`createDiagnostics` if not already imported) with the existing imports at the
top of `main.test.ts`, not inside the describe. Check what's already imported first and only add what's
missing (`main.test.ts` already imports from `./main` and mocks `@app/net/playwright-renderer`? Verify
— if playwright-renderer is NOT already mocked, spying the prototype as above is correct and needs no
mock).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/main.test.ts -t "scan command signal handling"`
Expected: FAIL — `runScanCommand` doesn't accept a `signals` param / doesn't register a handler.

- [ ] **Step 3: Implement in `main.ts`**

Add the import (with the existing `./` imports):
```ts
import { onShutdown, type SignalTarget } from "./signals";
```

Change the `runScanCommand` signature to append `signals`:
```ts
export async function runScanCommand(
  repo: Repository,
  log: Logger,
  opts: ScanCliOptions,
  diagnostics: Diagnostics,
  signals: SignalTarget = process,
): Promise<void> {
```

Lift the renderer to a local and register the handler. Currently the renderer is created inline inside
the `discoverDeps` object (`main.ts:121`: `renderer: new PlaywrightRenderer(),`). Change the flow:

Just before the `const result = await runScan(...)` call, create the renderer and register shutdown:
```ts
  const renderer = new PlaywrightRenderer();
  // On Ctrl+C, close the shared Chromium so we don't orphan a headless browser, then exit 130
  // (128 + SIGINT). This is the one place `process.exit` is justified: the in-flight scan `await`
  // would otherwise hang the process instead of terminating on the signal.
  const disposeShutdown = onShutdown(async () => {
    await renderer.dispose();
    process.exit(130);
  }, signals);
```

Replace the inline `renderer: new PlaywrightRenderer(),` in `discoverDeps` with `renderer,`.

Wrap the `runScan` call (and the trailing warnings loop that uses `result`) in `try { ... } finally { disposeShutdown(); }` so the handler is removed on normal completion:
```ts
  try {
    const result = await runScan(
      { /* ...unchanged deps, now using `renderer` local... */ },
      () => {},
    );
    for (const warning of result.warnings) {
      diagnostics.diag(style.warn(`  ! [${warning.source}] ${warning.message}`));
    }
  } finally {
    disposeShutdown();
  }
```
(Keep every existing dep and the no-op `() => {}` logger exactly as they are; the only change inside
the object is `renderer: new PlaywrightRenderer()` → `renderer,`.)

Update the one caller in `main()` — the `case "scan":` dispatch. It currently calls
`await runScanCommand(repo, log, { ... }, diagnostics);`. Leave it unchanged: `signals` defaults to
`process`, so production wiring needs no edit.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/cli/main.test.ts`
Expected: PASS (new describe + all existing scan/list/score tests).
Run: `npx vitest run src/cli`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/main.ts src/cli/main.test.ts
git commit -m "feat(cli): dispose the scan browser and exit 130 on SIGINT/SIGTERM"
```

---

### Task 4: Audit report + full CI-gate verification

**Files:**
- Modify: `_reports/audit/cli-best-practices-2026-07-10.md`

- [ ] **Step 1: Mark 1.8 shipped**

In the gap table, change the 1.8 row's Status from `Not yet done (PR C)` to `**Done — C1**` and update
its File(s) column to `signals.ts, serve.ts, main.ts`. Add a short note paragraph after the PR B note:

```markdown
**C1 shipped (2026-07-11):** 1.8 (`SIGINT`/`SIGTERM` — `serve` closes the listener + refresh
scheduler and exits 0; `scan` disposes the shared Chromium and exits 130, via the one-shot
`src/cli/signals.ts` helper) landed on `feat/cli-c1-signals`. Plan:
`docs/superpowers/plans/2026-07-11-cli-c1-signal-handling.md`. Remaining PR-C rows (3.7, 4.4) ship as
C2/C3.
```

Also update the "Already solid" note or the PR B "Remaining rows" line if it still lists 1.8 as pending
elsewhere (grep the file for `1.8` and reconcile every mention).

- [ ] **Step 2: Full CI-equivalent gate**

Run each; STOP and report BLOCKED on any failure (a `npm run lint:fix` + re-`lint` is fine):
- `npm run lint`
- `npm run typecheck`
- `npm run typecheck:web`
- `npm run test:coverage` (gate 93/85/90/93)
- `npm run test:web`
- `npm run build:web`

- [ ] **Step 3: Commit**

```bash
git add _reports/audit/cli-best-practices-2026-07-10.md
git commit -m "docs(cli): record C1 signal-handling in the audit report"
```

---

## Self-Review

**Spec coverage:**
- serve graceful shutdown (close listener + scheduler, exit 0) → Task 2. ✅
- scan clean-exit (dispose renderer, exit 130, no orphan) → Task 3. ✅
- shared idempotent `onShutdown` + injectable `SignalTarget` seam → Task 1. ✅
- handler deregistration on normal scan completion (no leak) → Task 3 (`finally` + test). ✅
- offline tests via the injectable seam, never signalling the vitest process → Tasks 1–3. ✅
- audit report update + CI gate → Task 4. ✅
- Out-of-scope items (AbortController threading, SharedViewReader disposal, C2/C3) correctly excluded — no tasks, matching the spec.

**Placeholder scan:** No TBD/TODO. Two spots defer a precise decision with an explicit rule, not a gap: the `SignalTarget` `= process` default widening (Task 1 Step 3, resolved by the Step 5 typecheck) and the "verify what main.test.ts already imports" note (Task 3 Step 1). Both give the concrete fallback.

**Type consistency:** `SignalTarget` / `onShutdown` names + signatures identical across Tasks 1→2→3. `registerServerShutdown` deps shape (`{ server, timer, signals }`) matches between its definition (Task 2 Step 3) and its test (Task 2 Step 1). `scheduleRefresh` return type change (`void` → `NodeJS.Timeout | undefined`) is consistent between the impl edit and the `startServer` capture. `runScanCommand`'s new trailing `signals?` param is append-only, so the existing `main()` caller compiles unchanged.

**Constraint adherence:** no new deps; no `!`; the single justified `process.exit(130)` is documented inline; tests are offline via the fake `EventEmitter` seam; `process.exitCode` used for serve (0), `process.exit` only for the scan signal path.

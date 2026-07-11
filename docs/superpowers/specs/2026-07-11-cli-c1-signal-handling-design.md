# CLI Lifecycle C1 — SIGINT/SIGTERM Handling — Design Spec

Date: 2026-07-11
Status: Approved (design)
Rubric: https://github.com/lirantal/nodejs-cli-apps-best-practices — practice **1.8** (graceful shutdown)
Parent design: `docs/superpowers/specs/2026-07-10-cli-best-practices-hardening-design.md` (PR C section)
Audit report: `_reports/audit/cli-best-practices-2026-07-10.md`

## Context

The parent "CLI Best-Practices Hardening" design grouped three lifecycle practices into a single
"PR C": 1.8 (signals), 4.4 (`#!/usr/bin/env node` entry), and 3.7 (shell completion). Those three
are independent and carry very different risk. Per the 2026-07-11 decision, PR C is **split into
three separately-shipped PRs by risk**:

- **C1 — SIGINT/SIGTERM handling (1.8)** — this spec. Low risk; touches `serve` + `scan` only.
- **C2 — shell completion (3.7)** — pure additive subcommand. Its own spec later.
- **C3 — `#!/usr/bin/env node` entry (4.4)** — bin rewrite + `tsx` → runtime dependency +
  install-script change. Highest blast radius (changes how the installed CLI boots for every user);
  shipped last and alone. Its own spec later.

This spec covers **C1 only**.

PR A (#139) and PR B (#142) already shipped/opened the earlier practices.

## Objective

Handle `SIGINT` (Ctrl+C) and `SIGTERM` gracefully for the two commands that own OS-level resources:

- **`serve`** (long-running HTTP listener + refresh scheduler): shut down cleanly and exit `0`.
- **`scan`** (one-shot crawl that launches a persistent headless Chromium): guarantee the browser is
  closed — **no orphaned Chromium process** — and exit `130` (128 + SIGINT), per convention.

Non-goals for C1: threading an `AbortController`/cancellation token through the discovery pipeline
(deferred — see "Deliberately out of scope"); signal handling for one-shot commands that own no
external resource (`list`, `score`, `profile`, `track`, `config` — Ctrl+C already terminates them
cleanly, nothing to clean up).

## Current state

- `startServer(opts: ServeOptions = {}): void` (`src/server/serve.ts:92`) is **synchronous**: it
  binds the Hono listener via `@hono/node-server`'s `serve(...)`, returns, and the process stays
  alive on the libuv handle. It holds a `server` handle (already calls `server.close()` in its
  `"error"` path, `serve.ts:138`) and starts a refresh scheduler via `scheduleRefresh(...)`
  (`serve.ts:119`).
- `scheduleRefresh(jobs, runScanForScope, hours)` (`serve.ts:147`) creates a `setInterval` timer,
  calls `timer.unref()`, and returns `void` — the timer handle is not currently exposed to the
  caller.
- `runScanCommand` (`src/cli/main.ts`) constructs the scan's `PlaywrightRenderer` inline at
  `main.ts:121` (`renderer: new PlaywrightRenderer()`) and passes it into `runScan` via
  `discoverDeps`.
- `PlaywrightRenderer` (`src/net/playwright-renderer.ts:47-74`) **lazily launches ONE Chromium** on
  the first render and reuses it for the whole scan; `dispose()` (`:70`) closes it once, and is
  currently invoked inside `discover.ts:315` at the end of discovery. `dispose()` is safe to call
  when no browser was ever launched. **This persistent Chromium is the orphan risk** on an
  interrupted scan.
- `PlaywrightSharedViewReader.read()` (`airtable-playwright.ts`) launches a short-lived Chromium and
  closes it in a `finally` (`:61-63`) — self-contained; not C1's responsibility.
- `process` currently has no `SIGINT`/`SIGTERM` listeners anywhere in the codebase (verified: no
  `process.on("SIG...")` in `src/`).

## Architecture

**Per-command handlers, not a global one.** Each command registers its own signal handler scoped to
the resources it owns, so cleanup logic lives next to the thing it cleans up. No signal wiring in
`main()`.

**Injectable signal target (the testability seam).** Both handlers attach to an injectable
`EventEmitter`-shaped target that defaults to `process`. Tests pass a fake emitter and
`emit("SIGINT")` so the test runner's own process is never signalled. The seam is a single optional
param with a `process` default — no behavior change in production.

```ts
// A minimal shape satisfied by both `process` and a test EventEmitter.
type SignalTarget = Pick<NodeJS.Process, "on" | "off"> ; // on/off("SIGINT"|"SIGTERM", handler)
```
(If `Pick<NodeJS.Process, ...>` proves awkward to satisfy from a bare `EventEmitter` under strict
types, fall back to a hand-written interface:
`type SignalTarget = { on(sig: "SIGINT" | "SIGTERM", h: () => void): unknown; off(sig: "SIGINT" | "SIGTERM", h: () => void): unknown }`.
The implementation plan picks whichever typechecks cleanly against both `process` and the test
emitter — no `as` casts.)

A small shared helper keeps both call sites honest about idempotency and the two signals:

```ts
// src/cli/signals.ts (NEW)
/**
 * Register a one-shot shutdown handler for SIGINT + SIGTERM on `target` (defaults to `process`).
 * The handler runs at most once (idempotent — a second Ctrl+C is ignored while shutting down).
 * Returns a `dispose()` that removes both listeners, so a one-shot command can deregister on normal
 * completion and not leak a handler into a later command sharing the process (tests, serve's jobs).
 */
export function onShutdown(
  handler: (signal: "SIGINT" | "SIGTERM") => void,
  target: SignalTarget = process,
): () => void;
```

`onShutdown` wraps `handler` in a `let firing = false` guard, registers the wrapped fn for both
signals, and returns a `dispose()` that calls `target.off(...)` for both. This is the single place
the idempotency + two-signal + cleanup logic lives; both `serve` and `scan` use it.

### `serve` — graceful shutdown (exit 0)

Inside `startServer`, after the listener binds:

1. Lift the scheduler timer so shutdown can clear it: change `scheduleRefresh` to **return the
   `NodeJS.Timeout | undefined`** it creates (undefined when the interval is disabled). Keep the
   `timer.unref()` behavior.
2. Register via `onShutdown((signal) => { ... })`:
   - `clearInterval(timer)` if a timer exists (deterministic scheduler stop, even though it's
     `unref()`'d).
   - `server.close()` (stop accepting connections; let in-flight requests drain).
   - `process.exitCode = 0;` — do NOT call `process.exit()`. After `server.close()` releases the
     listener handle and `clearInterval` releases the timer, the event loop empties and Node exits
     naturally with code 0. (Consistent with the repo's "never `process.exit()`" convention,
     audit 6.4.)
   - Idempotency is handled by `onShutdown`'s guard.
3. `startServer` stays `void`. Its `signals` param is added with a `process` default:
   `startServer(opts: ServeOptions = {}, signals: SignalTarget = process): void`.

Note the existing `"error"` path already sets `exitCode = 1` and calls `server.close()`; the
shutdown path is the success mirror (exit 0). No conflict — they're mutually exclusive events.

### `scan` — clean-exit, no orphan (exit 130)

Inside `runScanCommand`:

1. Lift the renderer to a named local: `const renderer = new PlaywrightRenderer();` before building
   `discoverDeps`, and reference it there (replacing the inline `new PlaywrightRenderer()` at
   `main.ts:121`). This gives the handler a reference to the orphan-risk resource.
2. Register `const disposeShutdown = onShutdown(async () => { await renderer.dispose(); process.exit(130); }, signals);`
   - This is the ONE place `process.exit()` is justified: on a signal we must terminate promptly
     with the conventional 130 after closing the browser; letting the loop drain naturally would
     leave the in-flight scan `await` hanging. Document the exception inline.
   - `renderer.dispose()` closes the persistent Chromium (safe if none launched). The
     `SharedViewReader`'s own `finally` covers its short-lived browser — not handled here.
3. **Deregister on normal completion:** call `disposeShutdown()` in a `finally` wrapping the scan
   body, so the handler doesn't leak into a later command in the same process (matters for tests and
   for `serve`'s background scans, which run in-process). `runScanCommand` gains
   `signals: SignalTarget = process`.

No `AbortController`, no mid-pipeline cancellation. An interrupted scan abandons its in-flight
`await`; sourcing commits incrementally (`runSourcing` upserts as it goes) and the next scan
reconciles liveness — so an interrupted scan is a partial-but-consistent scan, never corruption.

## Data flow

```
serve:  SIGINT/SIGTERM ─▶ onShutdown handler ─▶ clearInterval(timer) ─▶ server.close() ─▶ exitCode=0 ─▶ loop drains ─▶ exit 0
scan:   SIGINT/SIGTERM ─▶ onShutdown handler ─▶ await renderer.dispose() ─▶ process.exit(130)
        (normal completion) ─▶ finally ─▶ disposeShutdown() removes listeners
```

## Error handling / edge cases

- **Double Ctrl+C**: `onShutdown`'s `firing` guard makes the second signal a no-op. (For `scan`,
  once `process.exit(130)` is reached the process is ending anyway.)
- **Signal before any browser launched (scan)**: `renderer.dispose()` is a safe no-op — exit 130
  immediately.
- **Signal during `SharedViewReader.read()`**: its `finally` closes that browser on the normal path;
  on a hard signal we exit before it runs, but that Chromium is short-lived and tied to the reader's
  own launch — acceptable for C1 (the persistent renderer is the real orphan risk and IS handled).
- **`server.close()` callback error / port never bound**: `server.close()` is safe to call; if the
  listener failed to bind, the `"error"` path already ran with exit 1 — the shutdown handler on a
  never-bound server is harmless.
- **Handler leak across commands**: prevented by `scan`'s `finally` dispose. `serve` runs to process
  end, so it never needs to deregister.

## Testing

All offline, no real signals to the vitest process — use the injectable `SignalTarget` seam with a
fake `EventEmitter`.

- **`src/cli/signals.test.ts` (NEW)** — `onShutdown`:
  - Emitting `SIGINT` runs the handler once; emitting `SIGINT` again (or `SIGTERM` after) does not
    re-run it (idempotency).
  - Both `SIGINT` and `SIGTERM` are registered (each triggers the handler on a fresh emitter).
  - `dispose()` removes both listeners (after dispose, emitting does nothing).
- **`serve` shutdown** (in `src/server/*.test.ts` where `startServer`/app is tested, or a focused
  new test): inject a fake `SignalTarget` + assert that on `SIGINT` the injected server's `close` is
  called and the scheduler timer is cleared. Use a fake `serve`/timer seam — do NOT bind a real
  port. If `startServer` is too integration-heavy to unit-test directly, extract the shutdown
  registration into a small pure function that takes `{ server, timer }` and test that. The plan
  decides the exact seam after reading the existing serve tests.
- **`scan` shutdown** (`src/cli/main.test.ts`, which already harnesses `runScanCommand` offline):
  inject a fake `SignalTarget` and a spy renderer (the existing test already mocks discovery); assert
  that emitting `SIGINT` calls `renderer.dispose()`. Assert `process.exit` is invoked with `130`
  via a spy (`vi.spyOn(process, "exit").mockImplementation(...)` returning `never`), so the test
  process is not actually killed. Assert the handler is **removed** after a normal (no-signal) scan
  completes (emit `SIGINT` post-completion → `dispose` not called again).

## Conventions

TypeScript-strict ESM, `@app/*` alias, Biome (2-space/100-col/double-quotes), Conventional Commits,
**no Claude co-author footer**. No `!` assertions; avoid type assertions outside tests (the
`SignalTarget` seam is designed so no `as` is needed at the `process` default or the test emitter).
No new runtime dependencies. Colocated offline tests. Coverage gate (stmts 93 / branches 85 /
funcs 90 / lines 93) must stay green.

**Degrade-not-crash preserved.** Signal handling must not change the happy path: a scan/serve that
is never signalled behaves exactly as today (the handler is dormant, and `scan` deregisters it on
completion).

## Files

- `src/cli/signals.ts` — NEW: `onShutdown` + `SignalTarget`.
- `src/cli/signals.test.ts` — NEW.
- `src/server/serve.ts` — MODIFY: `scheduleRefresh` returns its timer; `startServer` gains a
  `signals` param and registers the shutdown handler (`clearInterval` + `server.close()` + exit 0).
- `src/cli/main.ts` — MODIFY: `runScanCommand` lifts the renderer to a local, gains a `signals`
  param, registers the exit-130 handler, and deregisters in a `finally`.
- Relevant test files — MODIFY/ADD per "Testing".
- `_reports/audit/cli-best-practices-2026-07-10.md` — MODIFY: mark 1.8 as shipped in C1.

## Success criteria

Practice 1.8 satisfied: Ctrl+C on `serve` closes the listener + scheduler and exits 0; Ctrl+C on
`scan` closes the shared Chromium (no orphaned process) and exits 130. Both idempotent. Covered by
colocated offline tests via the injectable signal seam. CI green (lint, typecheck ×2, coverage gate,
web tests, web build). The audit report's 1.8 row updated.

## Deliberately out of scope (C1)

- **AbortController through the scan pipeline** — prompt network-layer cancellation would thread a
  signal through `discover → connectors → fetcher/renderer`. Large, higher-risk; C1 takes the
  spec-sanctioned "smallest correct cut" (no orphan + correct exit code). Revisit only if partial
  cancellation latency proves to matter in practice.
- **`SharedViewReader` external disposal** — it self-closes; not an orphan risk worth C1's scope.
- **C2 (completion) / C3 (node shebang)** — separate specs/PRs.

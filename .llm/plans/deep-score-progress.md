# Deep-score live progress — implementation plan

## Context

Running a deep-score from the dashboard shows only a static "Scoring…" label and prints **nothing**
to the API terminal, while a discovery scan shows a live progress bar + a rolling activity list AND
logs every step as `[scan] …`. The gap is structural: the scan pipeline emits a typed
`ScanProgressEvent` stream (`src/domain/scan-progress.ts`) that both the CLI logger and the UI
render, whereas the deep-score seam only carries free-text stage strings and never touches the
terminal. `src/server/types.ts:24` states it outright: *"the LLM pipeline has no per-item progress."*

The per-item signal already exists in the pipeline — the deep-score loop increments
`counts.deepScored` after each posting and knows `survivors.length` up front
(`src/matching/score-run.ts:163-188`) — it's simply not surfaced. This plan adds a typed score
progress stream mirroring the scan one, so the UI gets a live **X/Y** counter + recent-titles list
and the terminal gets `[score] …` lines.

**Goal:** bring deep-score progress to parity with scan progress — staged messages, a live per-posting
counter, a rolling recent-titles list, and `[score]`-prefixed terminal logs.

## Approach (mirror the scan-progress architecture)

### 1. New typed progress stream — `src/domain/score-progress.ts` (new file, mirrors `scan-progress.ts`)
A `ScoreProgressEvent` union + a `formatScoreProgress(event)` one-liner (shared by the terminal
logger and the UI), with an exhaustiveness guard like `formatProgress`:
```ts
export type ScoreProgressEvent =
  | { kind: "planning" }
  | { kind: "triaging"; total: number }        // N titles going into triage
  | { kind: "triaged"; kept: number; total: number }
  | { kind: "scoring"; index: number; total: number; title: string }  // per-posting tick
  | { kind: "done"; deepScored: number };
```
`formatScoreProgress`:
- planning → `"Planning the deep-score run…"`
- triaging → `"Triaging N title(s)…"`
- triaged → `"Kept K of N after triage"`
- scoring → `"[index/total] title"` (matches the scan "company" line format)
- done → `"Deep-scored N posting(s)"`

### 2. Thread a progress callback through the pipeline — `src/matching/score-run.ts`
Add an optional `onProgress?: (event: ScoreProgressEvent) => void` to `RunScoreRunArgs` (keep
optional so the CLI path and existing tests are unaffected). Emit:
- `planning` at entry (before triage).
- `triaging` with `items.length` before `triager.triage`.
- `triaged` with `keptIds.size` / `eligible.length` after triage.
- `scoring` inside the deep-score loop. **Ordering caveat:** the loop is concurrent (`pLimit`), so
  derive a monotonic counter from `counts.deepScored + 1` at emit time rather than the map index, and
  emit the event immediately after the successful `saveMatchResult`. The `X` is "how many done",
  which is the honest live number under concurrency.
- `done` with `counts.deepScored` at the end.
Keep `onProgress` calls out of the `dryRun` early-return path (no work happens there).

### 3. Widen the score seam — `src/server/types.ts`
Change `ScoreRunner` from `(onStage: (message: string) => void)` to
`(onProgress: (event: ScoreProgressEvent) => void)`. Update the comment (drop the "no per-item
progress" line). This mirrors `ScanRunner`.

### 4. Emit through the runner — `src/server/score-runner.ts`
`runDeepScore` takes `onProgress` and passes it into `runScoreRun`'s new arg. Drop the two ad-hoc
`onStage?.("Planning…") / ("Scoring…")` calls (the pipeline now emits `planning`/`scoring` itself).

### 5. Terminal logging + status plumbing — `src/server/score-runner.ts`'s runner wrapper AND `score-job.ts`
Mirror `scan-runner.ts:40-42`: the production runner wraps the caller's `onProgress` so each event is
**both** forwarded to the job status **and** echoed to the terminal:
```ts
onProgress: (event) => {
  onProgress(event);
  console.log(`${style.dim("[score]")} ${formatScoreProgress(event)}`);
}
```
(Reuse `style` from `@app/cli/...` exactly as `scan-runner.ts` imports it.)

`score-job.ts` — enrich `ScoreJobStatus` to match `ScanJobStatus`'s shape:
- add `current: number | null`, `total: number | null`, `recent: string[]` (cap via a `MAX_RECENT`
  const, same as scan-job's 8).
- replace `onStage(message: string)` with `onProgress(event: ScoreProgressEvent)`: set
  `message = formatScoreProgress(event)`; on `triaging`/`scoring` set `total`; on `scoring` set
  `current = event.index` and push the formatted line into `recent` (sliced to MAX_RECENT); keep the
  existing terminal-independent `counts/estimate` snapshot on completion.

### 6. API contract — `web/src/api.ts`
Extend `ScoreJobStatusSchema` with `current: z.number().nullable()`, `total: z.number().nullable()`,
`recent: z.array(z.string())`. (The zod drift test guards client/server alignment — update both sides.)

### 7. UI — `web/src/views/Home.tsx`
In the deep-score panel (around lines 200-219), when `running`, render the same treatment the scan
panel uses (lines 119-133): a progress bar from `current/total` when `total` is set, and the `recent`
list. Reuse the existing markup/classes from the scan block so it reads as one system.

## Files
- Create: `src/domain/score-progress.ts`, `src/domain/score-progress.test.ts`
- Modify: `src/matching/score-run.ts` (+ `score-run.test.ts`), `src/server/types.ts`,
  `src/server/score-runner.ts`, `src/server/score-job.ts` (+ `score-job.test.ts`),
  `web/src/api.ts` (+ `api.test.ts` drift), `web/src/views/Home.tsx`
- Reuse: `formatProgress`/`scan-progress.ts` as the pattern template; `style` dim helper from the CLI
  (as `scan-runner.ts` uses it); `pLimit` concurrency already in `score-run.ts`.

## Tests (TDD, colocated, offline)
- `score-progress.test.ts`: `formatScoreProgress` for each variant (exhaustiveness + exact strings).
- `score-run.test.ts`: a fake scorer/triager drives a run; assert `onProgress` emits
  planning → triaging(total) → triaged(kept,total) → scoring ticks (index rising 1..N, correct title)
  → done(deepScored); assert dry-run emits no scoring events. Derive expected counts from inputs, not
  literals.
- `score-job.test.ts`: feeding progress events updates `current/total/recent/message`; `recent` caps
  at MAX_RECENT; completion still snapshots counts/estimate.
- `api.test.ts`: the score-status schema round-trips the new fields (back-compat: missing fields on an
  older server → validation still passes if we make them `.nullable()`/defaulted — decide during
  build, prefer nullable to match scan).

## Verification (end-to-end)
1. `npm run typecheck && npm run typecheck:web && npm run lint`
2. `npm run test:coverage` (server) + `npm run test:web` — all green, coverage ≥ gate.
3. Real run: `npm run cli -- serve`, trigger a deep-score from the dashboard. Confirm:
   - **Terminal** prints `[score] Planning…`, `[score] Triaging N…`, `[score] [k/Y] <title>` ticks,
     `[score] Deep-scored N…`.
   - **UI** shows a progress bar advancing k/Y and a rolling recent-titles list, not just "Scoring…".
4. `npm run build:web` succeeds.

## Notes / non-goals
- No change to the scan side (already correct) or the CLI score command's own output.
- Per-title stream only (title in the tick line); NOT streaming each posting's numeric score — that
  was the heavier "full detail" option we did not choose.
- Keep `onProgress` optional in `runScoreRun` so the CLI path and existing tests need no change.

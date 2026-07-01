# Deep-score with Claude — dashboard button

**Status:** Spec / not started · **Date:** 2026-06-30

## Objective

Let a user trigger the LLM (Claude) deep-score pass from the web dashboard, instead of only via the
`job-hunter score` CLI command. Today the UI's "Scan now" button runs the heuristic-only scan
(`scan-runner.ts:24`, `new HeuristicScorer(...)`); the deep-score pass that actually calls Claude
lives exclusively in `runScoreCommand` (`src/cli/main.ts:97`). The Settings UI already lets a user
set an Anthropic key (and `SettingsView.hasAnthropicKey` is on the wire), so the dashboard implies
LLM scoring is reachable when it isn't — this closes that gap.

## Current state (grounded references)

### The scan-job pattern we mirror
- `ScanJobManager` (`src/server/scan-job.ts:50`) — single-flight background job: `start(runner)`
  returns `false` if already running (`:70`), runs in the background (`:77`), captures progress via
  `onProgress` (`:102`), and exposes a pollable `getStatus()` snapshot (`:53`).
- `ScanJobStatus` (`src/server/scan-job.ts:9`) — `{ state, message, current, total, count, warnings,
  error, startedAt, finishedAt, recent }`.
- `ScanRunner` type (`src/server/types.ts:15`) — `(onProgress) => Promise<{count, warnings}>`.
- Routes: `POST /api/scan` → `jobs.start(runScan)`, 202 started / 409 already-running
  (`src/server/app.ts:248`); `GET /api/scan/status` → `jobs.getStatus()` (`:253`).
- Wiring: `serve.ts:90-96` constructs `new ScanJobManager()` + `createScanRunner(repo)` and injects
  both into `createApp`.
- Client: `useScanStatus` polls every 1s while running (`web/src/hooks.ts:141`); `useStartScan`
  POSTs and seeds the status cache (`:156`). Overview invalidates `["matches"]` on completion
  (`web/src/views/Overview.tsx:21`).

### The deep-score flow we trigger
- `runScoreRun` (`src/matching/score-run.ts:62`) — orchestrates: heuristic gate → remote
  partition → cap → skip-already-scored → batch title-triage → concurrent deep-score
  (`DEEP_SCORE_CONCURRENCY = 4`, `:18`).
- Returns `ScoreOutcome` (`:42`): `{ counts: ScoreStageCounts, estimate: CostEstimate, warnings,
  abortedOnLimit }`. `ScoreStageCounts` (`:30`) has `inDb, afterRemote, afterHeuristic, afterCap,
  alreadyScoredSkipped, triageTitles, deepScored, remotePenalized`.
- **No `onProgress`** — `runScoreRun` only takes `onWarning` (`:68`). Work is batched (triage is one
  call; deep-scores run concurrently), so there's no per-item progress stream like the scan has.
- **Usage-limit abort** (`:156`, `:180`): a usage-limit error during triage or deep-score sets
  `abortedOnLimit` and stops launching new work — it does NOT degrade to heuristic (unlike
  `LlmScorer`). This is the whole reason `runScoreCommand` builds a bespoke `abortingScorer`
  (`main.ts:128-153`) instead of reusing `resolveScorer`/`LlmScorer` (which fail-open everything —
  `resolve-scorer.ts:49`, `llm-scorer.ts`). **Preserve this distinction.**
- `runScoreCommand` (`src/cli/main.ts:97`) is the reference assembly: resolves provider/key/model
  (`resolve-settings.ts` `resolveProvider`/`resolveApiKey`/`resolveScorerModel`), builds the
  `abortingScorer` + `LlmTriager`, calls `runScoreRun`, then `formatScorePlan`
  (`src/cli/commands.ts:295`) + `formatUsageSummary`.
- Defaults (`src/cli/parse.ts`): `DEFAULT_MIN_HEURISTIC = 30` (`:7`), `DEFAULT_SCORE_LIMIT = 100`
  (`:9`), `remoteOnly` default `false`, `rescore` default `false`, `dryRun` default `false`.

### Key availability on the client
- `readSettings` (`src/server/app.ts:21`) exposes `hasAnthropicKey`; `SettingsView`
  (`web/src/api.ts`) carries it. The button can disable itself when `!hasAnthropicKey`.

## Design decisions (the ones worth confirming)

### D1 — Separate job manager, not a reused one. **(Recommend: separate)**
`ScanJobManager` is coupled to `ScanRunner`'s `{count, warnings}` return and to `ScanProgressEvent`.
Deep-score returns a richer `ScoreOutcome` and has no per-item progress. Two clean options:

- **(A, recommended) A parallel `ScoreJobManager`** with its own `ScoreJobStatus`
  (`{ state, message, counts, estimate, warnings, error, startedAt, finishedAt, abortedOnLimit }`).
  Mirrors `ScanJobManager`'s single-flight + pollable-snapshot shape but carries score-specific
  fields. Unit-testable the same way (inject a fake `ScoreRunner`).
- (B) Generalize `ScanJobManager` into a generic `JobManager<TResult>`. More refactor, touches the
  working scan path, higher regression risk. Not worth it for one more job type.

Also decide: **should scan and deep-score share one single-flight lock, or be independent?**
Recommend **independent jobs** (you can't deep-score while a scan is writing new postings, but the
two are sequential in practice; a shared lock would block the scheduler's refresh). Flag in the UI:
disable "Deep-score" while a scan is running and vice-versa, using each other's status.

### D2 — Progress granularity. **(Recommend: coarse stage messages)**
`runScoreRun` has no `onProgress`. Rather than thread a new progress callback through it (invasive),
emit **coarse server-side stage messages** by wrapping the call: "Planning…", "Triaging N titles…",
"Deep-scoring…", "Done — scored N". This needs a small `onStage?: (msg: string) => void` added to
`runScoreRun` at the three stage boundaries (`:135` dry-run gate, `:154` triage, `:169` deep-score),
OR — lighter — have the `ScoreRunner` wrapper set the messages around its calls without touching
`runScoreRun`. **Recommend the wrapper approach** to keep `runScoreRun` untouched and its tests
stable. The status `message` field carries the current stage; the final status carries `counts`.

### D3 — Dry-run preview first. **(Recommend: yes, two-step)**
`runScoreRun({ dryRun: true })` returns the plan + cost estimate with **zero LLM calls** (`:135`).
The UI should show a preview ("~N postings, est. $X.XX") and a confirm before spending. This mirrors
the CLI's `--dry-run`. Two endpoints (preview = synchronous dry-run; run = the job) keep it simple.

### D4 — Options surfaced in the UI. **(Recommend: minimal)**
Expose only `remoteOnly` (checkbox) and maybe `limit` (default 100). Keep `minHeuristic` (30) and
`rescore` (false) at their CLI defaults initially — add later if asked. `batchSize` and `cost` come
from the provider config, not the user.

## Proposed implementation

### Server
1. **`src/matching/score-run.ts`** — no change (keep it untouched; the wrapper carries stage
   messages). If progress granularity proves too coarse, revisit adding `onStage`.
2. **New `src/server/score-job.ts`** — `ScoreJobManager` + `ScoreJobStatus`, mirroring
   `scan-job.ts`. Single-flight; `start(runner)`; `getStatus()`. Unit-tested with a fake runner.
3. **New `src/server/score-runner.ts`** — `createScoreRunner(repo)` returning a `ScoreRunner`.
   Mirrors `runScoreCommand`'s assembly: `settingsWithEnvKey(repo)` → `resolveProvider` →
   `resolveApiKey` (throw a clean "No Anthropic key configured" if absent, so the job records it as
   the error) → `resolveScorerModel` → build the **same `abortingScorer`** and `LlmTriager` →
   `runScoreRun`. Set stage messages around each phase. Smoke-only (live LLM), like `scan-runner.ts`.
   Extract the `abortingScorer` builder out of `cli/main.ts` into a shared module
   (`src/matching/aborting-scorer.ts`) so CLI and server don't duplicate it.
4. **`src/server/types.ts`** — add `ScoreRunner` type + `scoreJobs` / `runScore` to `ServerDeps`.
5. **`src/server/app.ts`** — three routes:
   - `POST /api/score/preview` → synchronous `runScoreRun({ dryRun: true })`, returns `{ counts,
     estimate }`. 200. Returns 400/409-style `{ error }` if no key configured.
   - `POST /api/score` → `scoreJobs.start(runScore)`, 202 started / 409 running (mirror `/api/scan`).
   - `GET /api/score/status` → `scoreJobs.getStatus()`.
   Gate all three: if `!hasAnthropicKey`, return a clear error rather than starting.
6. **`src/server/serve.ts`** — construct `new ScoreJobManager()` + `createScoreRunner(repo)`, inject.

### Web
7. **`web/src/api.ts`** — zod schemas + methods: `previewScore(opts)`, `startDeepScore(opts)`,
   `getScoreStatus()`. New `ScoreJobStatusSchema`, `ScorePreviewSchema` (counts + estimate).
8. **`web/src/hooks.ts`** — `useScoreStatus` (poll 1s while running, like `useScanStatus`),
   `useStartDeepScore` (mutation; on completion invalidate `["matches"]`), `useScorePreview`.
9. **`web/src/views/Overview.tsx`** — add a "3 · Deep-score with Claude" card under the scan card:
   - Disabled with a hint when `!settings.hasAnthropicKey` ("Add an Anthropic key in Settings").
   - "Preview" → shows counts + est. cost; "Deep-score" → starts the job, shows stage message +
     spinner, disabled while a scan or score job is running.
   - On done: success line with `deepScored` count and any `abortedOnLimit` warning.

### Tests
- `score-job.test.ts` — single-flight, state transitions, error capture, abortedOnLimit surfaced
  (fake runner). Mirror `scan-job.test.ts`.
- `app.test.ts` — the three new routes: preview returns counts/estimate; POST 202/409; status shape;
  the no-key error path (inject a repo with no key → expect the gated error, no job started).
- `web` — `useStartDeepScore` invalidates `["matches"]`; Overview disables the button without a key;
  preview renders the estimate. (jsdom suite from PR #80.)
- Keep `runScoreRun` tests untouched (we don't modify it).

## Risks & mitigations
- **Spending real money from a button.** Mitigated by the mandatory dry-run preview (D3) and the
  cost estimate shown before the run.
- **Usage-limit abort must not silently degrade.** Reuse the exact `abortingScorer`, not
  `resolveScorer`/`LlmScorer`. Surface `abortedOnLimit` in the status so the UI can warn.
- **Concurrent scan + score writing the DB.** Make them mutually-exclusive in the UI (disable each
  while the other runs) even though the jobs are independent server-side.
- **Smoke-only code path.** `score-runner.ts` hits the live LLM, so it's excluded from coverage like
  `scan-runner.ts` (`vitest.config.ts` exclude list) — the unit-tested logic stays in
  `score-job.ts` + the pure `runScoreRun`.

## Tab rename (confirmed by user 2026-06-30)
The "Overview" tab isn't a summary — it holds profile upload + scan + (new) deep-score, i.e. the
"run the pipeline" actions. Rename the tab label **"Overview" → "Home"**.
- `TABS` in `web/src/App.tsx:10` — change the label; it's the first entry so it stays the default.
- Hash changes `#overview` → `#home`. `tabFromHash()` (`App.tsx:14`) already falls back to the first
  tab for any unknown hash, so stale `#overview` links land on Home — no breakage, no redirect needed.
- **Rename the component/file too** (user-confirmed): `web/src/views/Overview.tsx` → `Home.tsx`,
  `export function Overview` → `Home`, and the import in `App.tsx`. Full consistency, not just the
  label. The new deep-score card becomes "3 · Deep-score with Claude" on this (Home) tab.
- Update the App test's tab-navigation assertions (`web/src/App.test.tsx`) that reference "Matches"
  are unaffected, but any that reference the "Overview" label must switch to "Home".

## Decisions (confirmed by user 2026-06-30)
1. **Preview then run** — dry-run cost preview first, then a confirm to spend.
2. **Expose both `remoteOnly` (checkbox) and `limit` (default 100)** in the UI. Keep `minHeuristic`
   (30) and `rescore` (false) at defaults. Reuse `DEFAULT_SCORE_LIMIT`/`DEFAULT_MIN_HEURISTIC` from
   `src/cli/parse.ts` (`:9`, `:7`) rather than re-declaring; `remoteOnly` default resolves via
   `resolveRemoteOnly(settings, override)` from `REMOTE_ONLY_SETTING`.
3. **Overview card** — a "3 · Deep-score with Claude" card under the scan card.
4. **Mutually exclusive with scan** — disable each while the other runs (poll both statuses).

## Refinements from codebase audit (fold into implementation)
- **`hasAnthropicKey` env-var gap (must fix).** `readSettings` (`app.ts:23`) checks the *stored* key
  directly, NOT through `settingsWithEnvKey`. A user relying on the `ANTHROPIC_API_KEY` env var would
  see `hasAnthropicKey: false` and a disabled button, even though `createScoreRunner` (via
  `settingsWithEnvKey`) would score fine. Fix: compute `hasAnthropicKey` through
  `settingsWithEnvKey(repo)` so the button's enablement matches actual availability. (Touches the
  Settings response — add an app.test.ts case with the env var set.)
- **Abort messaging.** `isUsageLimitError` matches "usage limit" / "usage limits" / "rate limit"
  (case-insensitive) and *deliberately excludes* auth/401. So `abortedOnLimit` means "hit a usage or
  rate limit" — surface it as "stopped early — provider usage/rate limit reached (scored N of M)".
  A bad key still fails loudly as a job error, not a silent abort.
- **Share the `abortingScorer` builder.** Extract `main.ts:128-153` into
  `src/matching/aborting-scorer.ts` so CLI and `score-runner.ts` don't duplicate the exact
  re-throw-on-limit logic (the whole reason we can't reuse `LlmScorer`).
- **No live per-item progress in v1.** `runScoreRun` has no `onProgress`; adding one means threading
  a callback through the `pLimit` loop (`score-run.ts:176-178`). Keep v1 to coarse stage messages
  (Planning → Triaging → Deep-scoring → Done) set by the runner wrapper; the final status carries
  `ScoreStageCounts`. Revisit live `deepScored/total` only if the coarse view feels insufficient.

## Out of scope (for a v1)
- Per-posting progress (would need `onProgress` threaded through `runScoreRun`).
- Scheduling automatic deep-scores (the scheduler currently only refreshes the heuristic scan).
- Exposing `minHeuristic`/`rescore`/`batchSize` in the UI.

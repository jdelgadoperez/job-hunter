# Design: Split scan/score, heuristic-gated batch LLM scoring, remote filter

Date: 2026-06-26
Status: Approved (design); pending implementation plan

## Problem

Today `runScan` (`src/cli/commands.ts`) does discover → save → **LLM-score every posting** →
liveness recheck in one command. Scoring is one LLM call per posting (`LlmScorer.score`, bounded at
concurrency 4) with no pre-filter, so the LLM scores roles that will never match the user (wrong
domain, wrong seniority, non-engineering). A single run can send ~1,200 postings to the expensive
deep-score path (~$36/run at ~$0.03/posting). This burned ~$25 and hit a provider usage-limit `400`:

```
[llm-scorer] LLM scoring failed: 400 {"type":"error","error":{"type":"invalid_request_error",
"message":"You have reached your specified API usage limits..."}}; using the heuristic scorer
```

## Goals

1. Split **scan** (discover/store, free) from **score** (LLM scoring, paid) into distinct,
   independently-runnable commands that can be run back-to-back as a pipeline.
2. Use the free heuristic scorer to **rank and gate** which postings reach the LLM, then have the
   LLM **triage titles in batches** (keep/drop) before any expensive per-posting deep scoring.
3. Add **location awareness** with a **remote-only** preference, so non-remote roles don't consume
   LLM budget.

## Non-goals (YAGNI)

- No web/dashboard UI for `score` (cost-sensitive CLI op; dashboard can follow later).
- No per-provider price auto-fetch (hardcoded cost constants with a comment).
- No changes to discovery connectors.

## Pipeline shape & commands

`scan` and `score` are distinct commands sharing the same SQLite DB. The find-jobs flow is
`scan` then `score`.

- **`scan`** — discover → save → **heuristic-score everything** (free) → liveness recheck. No LLM,
  no spend. After a scan, `list` works immediately with heuristic scores. This is today's `runScan`
  with the LLM scorer replaced by the heuristic for the score step.

- **`score`** (new) — operates only on postings already in the DB. Five ordered stages, each
  shrinking the candidate pool before any spend:

  ```
  all postings in DB
    1. REMOTE FILTER (free) ── remote_only on? drop non-remote (kept if location unknown)
    2. HEURISTIC GATE (free) ── keep heuristic score >= --min-heuristic (default 30), rank desc
    3. CAP (free) ──────────── take top --limit (default 100) by heuristic score
    4. BATCH TITLE-TRIAGE (cheap LLM) ── ~40 titles/call, LLM returns keep/drop + reason per title
    5. DEEP SCORE (expensive LLM) ────── full per-posting score on triage survivors
    └─→ write MatchResult per posting (scorer='llm'), overwriting the heuristic row
  ```

### Gating: Option A — threshold + cap

Two knobs bound spend on both ends:
- `--min-heuristic <n>` (default 30) — floor; drops the obvious junk before paying for triage.
- `--limit <n>` (default 100) — hard ceiling; cost cannot exceed `limit x per-deep-score-cost`.

Illustrative run (~1,200 discovered): ~60 score >=50, ~180 score 30–49, ~960 score <30.
With `--min-heuristic 30 --limit 100`: triage ~the top 100 at >=30, deep-score survivors.
Rough cost ~$2–6/run vs ~$36 today.

## `score` internals

New module **`src/matching/score-run.ts`** orchestrates stages 1–5. Dependency-injected like
`runScan`: takes `{ repo, profile, triager, scorer, settings, options }`, returns a `ScoreOutcome`
(per-stage counts + warnings + cost estimate). Keeps `commands.ts` thin and the flow unit-testable
offline with fixtures. Stages 1–3 are plain array operations over candidates returned by the repo.

### Stage 4 — batch triage (`LlmTriager`)

New scorer-sibling to `LlmScorer`:
- Input: profile + a batch of `{ id, title, location }` (titles only — no descriptions; cheap).
- Output (zod-validated): `{ decisions: { id, keep: boolean, reason: string }[] }`.
- Prompt: "For each title decide if it's plausibly worth a full review — keep generously on
  adjacent/equivalent roles, drop clear mismatches (wrong domain, wrong seniority, non-engineering)."
- **Fail-open**: a failed/ malformed triage batch **keeps** its postings (they proceed to
  deep-score) and emits one `Warning`. Matches the project's "degrade, never crash" ethos; better to
  over-score a batch than silently drop real matches.

### Stage 5 — deep score

Reuses the existing `LlmScorer.score` unchanged, fed only the small pre-vetted survivor set.
- A degraded deep-score (LLM failure) keeps the existing heuristic row marked `scorer='heuristic'`
  so a later `--rescore` retries it rather than treating it as done.

### Re-run behavior

- `score` **skips postings already LLM-scored** in a prior run (cheap re-runs that only pick up new
  postings). `--rescore` forces re-scoring of already-LLM-scored postings.

## Data model

One additive column via the existing idempotent `Repository.migrate()`:
- `match_results.scorer TEXT` — `'heuristic'` | `'llm'` (nullable for legacy rows → treated as
  unknown → eligible for scoring).

Writes:
- `scan` heuristic pass writes `scorer='heuristic'`.
- `score` stage 5 writes `scorer='llm'`.
- `score` stage-0 excludes `scorer='llm'` unless `--rescore`.

New / changed repo methods:
- `listPostingsForScoring({ minHeuristic, includeAlreadyScored })` → candidate `JobPosting`s joined
  with their heuristic score, ranked desc, so stages 1–3 are array ops in `score-run.ts`.
- `saveMatchResult(postingId, result, scorer = 'heuristic')` — added `scorer` arg, defaulted so
  existing callers are untouched.

The `MatchResult` domain type is **unchanged** — `scorer` is a storage concern. So `list`, the web
API (`/api/*`), and the dashboard read `MatchResult`s exactly as before. No web changes.

## Remote filter

- Saved setting via `repo.setSetting`/`getSetting`: key `remote_only`, value `"true"`/`"false"`.
  Set with `job-hunter config remote <on|off>` (mirrors provider/model settings).
- `score` reads it as default; `--remote` / `--no-remote` override per-run.
- Pure matcher in new **`src/matching/remote-filter.ts`**: `isRemote(location?: string): boolean`,
  regex over the free-text field (`/\b(remote|anywhere|distributed|work from home|wfh)\b/i`).
  **Unknown location (undefined/empty) → kept** (never silently drop on a missing field).
- Non-remote postings stay in the DB and keep their free heuristic score; they are excluded only
  from the LLM stages. Reversible — flip the setting and re-score without re-scanning.

## Dry-run cost preview

`score --dry-run` runs stages 1–3 (all free), prints the plan, and **exits before any LLM call**:

```
Score plan (dry run)
  In DB:                1,204 postings
  Remote filter:          412 remain   (remote_only=on)
  Heuristic >=30:         187 remain
  Cap (--limit 100):      100 selected
  Already LLM-scored:      18 skipped   (--rescore to re-score)
  -> Triage:               82 titles  (3 batches)   est. ~$0.25
  -> Deep-score (max):     82 postings                est. ~$2.46
  Estimated total:                                    ~$2.71
```

Cost constants (per-triage-title, per-deep-score) live in `llm-providers.ts` next to provider/model
config (price is provider-specific). The estimate is a labeled approximation, not a billing
guarantee. The estimator is pure and unit-tested.

## Error handling (degrade, never crash)

- Triage batch fails → fail-open (keep batch) + `Warning`.
- Deep-score fails → existing `LlmScorer` degrades to heuristic + `Warning`; row stays
  `scorer='heuristic'` so `--rescore` retries it.
- **Usage-limit / auth error (the original failure)** → early-abort: on first such error, `score`
  stops making new LLM calls, prints completed + remaining, exits cleanly. No hammering a hard limit.
- No API key → `score` prints "no LLM key configured; nothing to score (scan already
  heuristic-scored everything)" and exits 0. `scan` unaffected.
- No profile → same guard as today.

## CLI surface

```
job-hunter scan                          # discover + store + heuristic-score (free)
job-hunter score [opts]                  # LLM gate + triage + deep-score
    --min-heuristic <n>   (default 30)
    --limit <n>           (default 100)
    --remote / --no-remote               # override saved remote_only setting
    --rescore                            # re-score already-LLM-scored postings
    --dry-run                            # print cost plan, spend nothing
job-hunter config remote <on|off>        # persist remote_only setting
job-hunter list                          # unchanged
```

- `parse.ts` gains `score` and `config` cases + flag parsing.
- `help.ts` gains entries for both.
- `main.ts` wires `score` to a new `runScoreCommand` (mirrors `runScanCommand`: resolves profile,
  scorer, triager, settings; calls `score-run.ts`).

## Testing (offline, fixture-driven, coverage gate stays green)

- `remote-filter.test.ts` — `isRemote` against real fixture strings + unknown-kept.
- `score-run.test.ts` — five-stage flow with injected fake triager/scorer: gate threshold, cap,
  remote filter, skip-already-scored + `--rescore`, fail-open triage, early-abort on usage-limit,
  dry-run spends nothing. Asserts against computed values, not hard-coded expectations.
- `llm-triager.test.ts` — batch parse, zod validation, degrade-on-error.
- Repo tests for the new `scorer` column + `listPostingsForScoring`.
- Cost estimator — pure, unit-tested directly.
- Live LLM calls stay out of CI (`smoke:scorer` sibling note only).

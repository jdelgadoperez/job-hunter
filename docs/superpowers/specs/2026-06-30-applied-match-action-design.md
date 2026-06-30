# "Applied" match action — Design

**Issue:** [#63](https://github.com/jdelgadoperez/job-hunter/issues/63) (reshaped — see Scope deviation)
**Date:** 2026-06-30
**Status:** Approved design
**Base:** stacks on `feat/matches-remote-country-filters` (PR #78), which it shares files with.

## Summary

Add a single new `applied` user action so a posting you've applied to stops resurfacing in the
default Matches list — but, unlike `dismissed`, stays easy to bring back and review. Pure extension
of the existing `user_actions` machinery: no new table, no new column.

## Scope deviation from the written issue

Issue #63 as written asked for **two** new actions, `applied` and `ignored`. During design we
decided:

- **Drop `ignored`.** It would behave identically to the existing `dismissed` (hide by default,
  revealable). The intent distinction ("deliberately passing" vs "not interested") doesn't earn a
  second enum value or its own toggle — it's redundant surface. `dismissed` already covers it.
- **Add a filter for `applied`, not just a reveal toggle.** Beyond a "Show applied" toggle (mirroring
  "Show dismissed"), add an **"Applied (N)" filter view** that shows only applied roles — answering
  "what did I apply to?" directly. This is slightly more than the issue's "mirror Show dismissed,"
  and is a deliberate addition.

Net: **add only `applied`**, hidden by default, with both an inline reveal toggle and a dedicated
filter view. The GitHub issue will be updated to match this scope.

## Goals

- `applied` action, mutually exclusive with `saved`/`dismissed` (single-action model unchanged).
- Applied postings hidden from the default Matches list.
- A "Show applied" toggle reveals them inline (alongside everything else).
- An "Applied (N)" filter shows only applied postings, with a live count.
- A "Mark applied" button on each match card; toggling it off clears the action.
- CLI parity is **out of scope** (the issue is dashboard-focused; the CLI `list` has no action
  buttons today — actions are a dashboard concept).

## Non-goals

- `ignored` (dropped, see above).
- Application-status tracking beyond a single flag (interview stages, dates, notes) — explicitly out
  of scope per the issue.
- Multi-action-per-posting / coexisting flags (would need a schema change; the single-action model
  is retained).
- A new DB table or column — this is an enum + filter change only.

## Global constraints

Copied from the project conventions (CLAUDE.md); every task inherits these.

- TypeScript-strict, ESM, ES2022; `noUncheckedIndexedAccess`, `noImplicitOverride` on.
- **No `!` non-null assertions. No type assertions outside tests.**
- No new runtime dependencies.
- Biome: 2-space, 100-col, double quotes. **Verify lint with the exact CI command (`npm run lint`,
  i.e. `biome check .`), at full project scope — never a file subset** (a subset check passing is not
  the project gate passing).
- Tests colocated, offline, fixture-driven. Coverage gate stays green: statements 92 / branches 85 /
  functions 90 / lines 93.
- **Failures degrade, never crash.** Lenient query-param parsing on `/api/matches` (bad/absent ⇒
  default, no 400s) — except the action-write endpoint, which validates and 400s on a bad action
  (existing behavior, preserved).
- SQLite is the only store that has `user_actions` (it's local per-user state; the Postgres backend
  is the shared scan store and has no user actions) — so no SQLite↔Postgres lockstep concern here.
- Conventional Commits. No Claude co-authored footer.

## Decisions (resolved during brainstorming)

| Question | Decision |
|---|---|
| One action vs many per posting | One (mutually exclusive). `applied` replaces a prior action, like `dismissed`. No schema change. |
| Reveal mechanism | Both: a "Show applied" inline toggle AND an "Applied (N)" filter-only view. |
| `ignored` | Dropped — redundant with `dismissed`. |
| CLI parity | Out of scope (dashboard-only feature). |
| Issue update | Update #63 to match the reshaped scope (shown for approval before posting). |

## Architecture

No schema change. The `user_actions` table already stores one free-text `action` per posting
(PK `posting_id`); `applied` is a new accepted value.

### Types

`UserAction` gains `"applied"` in both definitions, kept identical:
- `src/storage/repository.ts` — `export type UserAction = "saved" | "dismissed" | "applied";`
- `web/src/api.ts` — same.

### Action write API (`src/server/app.ts`)

`PUT /api/matches/:id/action` currently accepts `"saved" | "dismissed"`. Add `"applied"` to the
validated set and update the 400 error message. `DELETE` (clear action) is unchanged. The write still
validates and rejects unknown actions — this endpoint is the one place that 400s, deliberately.

### Filtering (`src/storage/repository.ts` `listScoredPostings`)

Today the default-hide clause is:
```
AND (ua.action IS NULL OR ua.action != 'dismissed')   -- unless includeDismissed
```

Extend so `applied` is also hidden by default, with two new `ListMatchesOptions`:
- `includeApplied?: boolean` — when true, applied rows are NOT hidden (inline reveal).
- `onlyApplied?: boolean` — when true, the query shows ONLY applied rows (`AND ua.action =
  'applied'`), overriding the hide clauses for other states as appropriate.

Resulting clause logic (in priority order):
- If `onlyApplied`: `AND ua.action = 'applied'` (and the dismissed/applied default-hide clauses are
  not added — we're explicitly asking for applied).
- Else: keep the existing dismissed hide (unless `includeDismissed`) AND add an applied hide
  `ua.action != 'applied'` unless `includeApplied`.

Both `dismissed` and `applied` hide clauses must tolerate `ua.action IS NULL` (no action) — those
postings always show. Preserve the existing `IS NULL OR ...` shape.

### `/api/matches` params (`src/server/app.ts`)

Read two new lenient params, matching the `includeDismissed` convention:
- `includeApplied: c.req.query("includeApplied") === "true"`
- `onlyApplied: c.req.query("onlyApplied") === "true"`

Pass both into `listScoredPostings` options.

### Web (`web/src/api.ts`, `web/src/hooks.ts`, `web/src/views/Matches.tsx`)

- `MatchFilters` gains `includeApplied?: boolean` and `onlyApplied?: boolean`; `getMatches` sets each
  query param only when truthy (existing convention).
- `UserAction` web type gains `"applied"`.
- `useMatches` query key includes both new flags (so toggling refetches — the cache-key discipline
  from PR #78).
- **MatchCard:** a "Mark applied" / "✓ Applied" button next to Save/Dismiss. When the posting's
  action is `applied`, the button is in the active state and clicking it clears the action (sets
  null); otherwise clicking sets `applied`. (Mirrors the existing Save toggle behavior.)
- **Filter controls:** a "Show applied" checkbox (mirrors "Show dismissed") bound to `includeApplied`;
  and an "Applied (N)" control that sets `onlyApplied`. The two are mutually sensible — when
  `onlyApplied` is on, "Show applied" is irrelevant (the view is already only-applied); the UI should
  make `onlyApplied` a distinct mode (e.g. a button/segmented control), not just another checkbox, to
  avoid a confusing both-on state. Implementation detail fixed in the plan.
- **Applied count (N):** the count of applied postings, independent of the current view, comes from a
  lightweight `onlyApplied` query (same pattern as PR #78's country-options second query — TanStack
  dedupes; it only fires its own request when needed). The plan specifies whether N reflects
  score-floor or all applied; default: applied postings at or above the current `minScore` (so N
  matches what the filter would show).

## Data flow

```
user clicks "Mark applied" → PUT /api/matches/:id/action {action:"applied"}
   → repo.setUserAction(id, "applied")  (replaces any prior action; PK posting_id)

list (default)      → applied hidden (AND ua.action != 'applied')
list + Show applied → includeApplied=true → applied shown inline
list + Applied (N)  → onlyApplied=true   → only applied rows
count badge         → onlyApplied query (count) → "Applied (N)"
```

## Error handling

- Action-write endpoint validates and 400s on an unknown action (preserved).
- `/api/matches` new params are lenient (absent/other ⇒ false ⇒ default behavior).
- A posting with no action always shows regardless of the new clauses (the `IS NULL` guard).
- `onlyApplied` + `includeApplied` both true: `onlyApplied` wins (only-applied view); documented so
  the UI never lands in an ambiguous state.

## Testing strategy

Colocated, offline, existing patterns (`repository.test.ts` in-memory repo; `app.test.ts`
`app.request()`).

- **repository.test.ts:**
  - `applied` is hidden by default; shown with `includeApplied`; `onlyApplied` returns only applied.
  - A no-action posting always shows under every combination.
  - `onlyApplied` + `includeDismissed`/`includeApplied` interaction: only-applied wins.
  - Setting `applied` replaces a prior `saved`/`dismissed` (single-action model).
- **app.test.ts:**
  - `PUT .../action {action:"applied"}` succeeds; an unknown action still 400s with the updated
    message.
  - `GET /api/matches?includeApplied=true` reveals applied; `?onlyApplied=true` returns only applied;
    default hides applied.
- **Web:** typecheck:web + build:web are the gates (no component test setup). If asserting button
  wiring is cheap via the existing `api.ts` param construction, cover the query-param mapping.

## Risks

- **Stacks on the unmerged PR #78** — shares `listScoredPostings`, `ListMatchesOptions`, `app.ts`
  `/api/matches`, `Matches.tsx`, web `MatchFilters`. Mitigation: branch from #78's HEAD; if #78 merges
  first, rebase. Keep the clauses additive so they compose with #78's remote/country filters.
- **Clause interaction complexity** — four hide/show conditions now compose (expired, dismissed,
  applied, remote/country from #78). Mitigation: explicit truth-table tests for the applied
  combinations; keep each clause independently `IS NULL`-safe.
- **`onlyApplied`/`includeApplied` UI ambiguity** — mitigated by making `onlyApplied` a distinct mode,
  not a co-equal checkbox.

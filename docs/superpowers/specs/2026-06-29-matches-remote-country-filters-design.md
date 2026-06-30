# Remote & Country: structured extraction, filtering, and scoring — Design

**Issue:** [#76](https://github.com/jdelgadoperez/job-hunter/issues/76) (efforts A + B, expanded)
**Date:** 2026-06-29
**Status:** Approved design

## Summary

Make "is this role remote?" and "what country is it in?" first-class, reliable
properties of a posting — extracted from ATS payloads where possible, persisted,
filterable in the dashboard and CLI, surfaced as a badge, and reflected in
scoring. Today both facts live only in a single free-text `location` string and
are recovered (for remote) by a regex used only on the scoring path.

This covers all of issue #76 **except** seniority and years-of-experience
(effort C), which remains deferred.

## Goals

- Add structured `remote?: boolean` and `country?: string` to `JobPosting`,
  persisted in both SQLite and Postgres.
- Extract a structured remote signal from ATS feeds that expose one; fall back to
  the existing free-text regex otherwise.
- Filter the **Matches** view (and `/api/matches`, and CLI `list`) by remote and
  by country.
- Show a **Remote** badge on each match card.
- When the user prefers remote, rank non-remote/unknown postings lower (in both
  the LLM and heuristic scorers) instead of dropping them.

## Non-goals

- Seniority / years-required extraction and filtering (effort C — deferred).
- A new "prefer remote" setting — we reuse the existing `remoteOnly` setting.
- Backfilling `remote`/`country` for already-stored postings beyond what a normal
  re-scan produces. New columns are nullable; values populate as postings are
  re-fetched.
- City/region granularity. Country is the only geographic field added.

## Global constraints

These bind every task. Copied from the project's conventions (CLAUDE.md) and the
existing code.

- TypeScript-strict, ESM, target ES2022, `moduleResolution: bundler`.
  `noUncheckedIndexedAccess` and `noImplicitOverride` are on.
- **No `!` non-null assertions. No type assertions outside tests.** Prefer type
  guards and runtime narrowing.
- No new runtime dependencies. Use existing deps (`zod`, `better-sqlite3`,
  `postgres`, Hono, React/TanStack Query) and small custom helpers.
- Biome: 2-space indent, 100-col width, double quotes. `npm run lint:fix` before
  committing.
- Tests colocated (`*.test.ts`), offline, fixture-driven. Coverage gate
  (vitest.config.ts) must stay green: statements 92 / branches 85 / functions 90
  / lines 93. New code carries its own tests.
- **Failures degrade, never crash.** A connector that can't determine remote or
  country leaves the field `undefined` — never throws, never drops the posting.
- **SQLite and Postgres posting shapes stay in lockstep.** Any column added to
  one is added to the other in the same effort.
- Lenient query-param parsing: match the existing `/api/matches` convention
  (bad/absent input falls back to a default; no 400s).

## Decisions (resolved during brainstorming)

| Question | Decision |
|---|---|
| Unknown location under "Remote only" | Still shows (reuse `isRemote()`, blank ⇒ remote). Don't silently drop. |
| Country: parse-on-read vs persist | **Persist** a normalized `country` column (SQLite + Postgres), extracted at scan time. |
| Country UI control | Dropdown populated from the distinct countries present in the current results, plus an "All" default. |
| CLI parity | Include `--remote-only` and `--country` on `list`. |
| Remote scoring penalty | Apply in **both** the LLM scorer (prompt signal) and the `HeuristicScorer` (deterministic penalty). |
| Penalty trigger | The existing `remoteOnly` setting. On ⇒ penalize non-remote/unknown; off ⇒ no penalty. No new setting. |
| ATS remote flag vs regex | **Structured ATS flag wins**; `isRemote(location)` regex is the fallback when the flag is absent. |
| Remote LLM output field | None. Remote is an **input** signal to the LLM (goes in the cacheable system prefix); `MatchPayloadSchema` is unchanged. |

## Behavior change to call out

Today `remoteOnly` **filters** on the scoring path — `score-run.ts` drops
non-remote candidates (`gated.filter((c) => isRemote(c.posting.location))`).
This design **changes that from a drop to a penalty**: with `remoteOnly` on,
non-remote/unknown postings are scored lower but still stored and shown. The
Matches "Remote only" toggle becomes the place a user *hides* non-remote roles.
This is intentional and must be documented in the PR and README. (Rationale: the
user explicitly asked for "show but lower in score," and dropping during scoring
permanently loses the posting from the DB.)

## Architecture

### Data model (`src/domain/types.ts`)

`JobPosting` gains two optional fields:

```ts
export type JobPosting = {
  // ...existing fields...
  location?: string;
  remote?: boolean;   // new — true/false when known, undefined when not determinable
  country?: string;   // new — normalized country, e.g. "US", "UK", "Germany"; undefined when unknown
  postedAt?: Date;
  fetchedAt: Date;
};
```

Both are optional and follow the existing spread-omit persistence pattern
(`...(row.remote != null ? { remote: row.remote } : {})`).

### Remote resolution (`src/matching/remote-filter.ts`)

`isRemote()` stays as the regex fallback. Add a new resolver that codifies the
"structured flag wins" rule:

```ts
/** Resolve whether a posting is remote: trust a structured flag, else fall back to the location regex. */
export function resolvePostingRemote(posting: Pick<JobPosting, "remote" | "location">): boolean {
  if (posting.remote !== undefined) return posting.remote;
  return isRemote(posting.location);
}
```

This single helper is the one definition of "remote" used by the badge, the
filter, the CLI, and the scorer penalty — so they never disagree.

### Country normalization (`src/matching/location-filter.ts` — new)

Modeled on `remote-filter.ts`: a pure, dependency-free helper that maps a
free-text location to a normalized country, or `undefined` when it can't.

```ts
/** Normalize a free-text location to a country label, or undefined when undeterminable. */
export function parseCountry(location?: string): string | undefined;
```

Rules (in order):
1. Blank/undefined ⇒ `undefined` (unknown — never guessed).
2. Explicit country name or ISO code at the end of the string
   ("Berlin, Germany" ⇒ "Germany"; "Remote - US" ⇒ "US"; "London, UK" ⇒ "UK")
   via a small alias map (ISO-2/ISO-3/common names → canonical label).
3. US-state inference: a trailing 2-letter US state code or US state name
   ("San Francisco, CA" ⇒ "US") via a US-states set.
4. Otherwise ⇒ `undefined`. Unparseable ≠ dropped — it just won't match a
   specific-country filter.

The alias/state maps are static module constants (no new dependency). Canonical
labels: ISO-2 where common ("US", "UK", "CA"), full name otherwise ("Germany",
"France") — chosen to read well in the dropdown. The exact label set is fixed in
the implementation plan.

Country is computed **once at scan time** (in the scan pipeline, from the final
`location`) and persisted, so the dashboard dropdown and filters query a stored
value rather than re-parsing on every request.

### ATS connector extraction

Add the structured remote signal to the Zod schema and mapper of each connector
that exposes one. The shared mapper intermediate `MappedJob` (in
`src/discovery/connectors/ats-feed.ts`) gains an optional `remote?: boolean`,
threaded into the produced `JobPosting`.

| Connector | Structured field | Mapping |
|---|---|---|
| **Lever** | `workplaceType` (top-level string) | `"remote"` ⇒ `true`; `"office"`/`"hybrid"`/`"on-site"` ⇒ `false`; absent ⇒ `undefined` |
| **Ashby** | `isRemote` (boolean) | pass through directly |
| **Rippling** | `locations[].workplaceType` | any location `"REMOTE"` ⇒ `true`; all present and none remote ⇒ `false`; absent ⇒ `undefined` |
| **Browser / JSON-LD** | `jobLocationType` (schema.org) | `"TELECOMMUTE"` ⇒ `true`; other present value ⇒ `false`; absent ⇒ `undefined` |

All other connectors (Greenhouse, Workday, Workable, Recruitee, SmartRecruiters,
BambooHR, UKG, Breezy) expose **no** structured remote field — they leave
`remote` undefined, and `resolvePostingRemote()` falls back to the
`isRemote(location)` regex. This is correct and expected; the spec does not
fabricate a signal where the payload has none.

Country is **not** extracted per-connector — it's derived uniformly from the
final `location` by `parseCountry()` in the scan pipeline, so all sources get
consistent country handling regardless of ATS.

### Persistence

**SQLite** (`schema.ts` + `migrate()` + `savePosting` + row mapper):
- `CREATE TABLE` gains `remote INTEGER` (0/1) and `country TEXT`.
- `migrate()` gets two guarded `ALTER TABLE postings ADD COLUMN` blocks following
  the existing `last_seen_scan`/`expired_at` PRAGMA-check pattern (idempotent for
  existing DBs).
- `savePosting` upsert binds `remote` (as 0/1/null) and `country` (text/null) in
  both INSERT and ON CONFLICT branches.
- Row→JobPosting mapper spreads them with the existing optional-omit pattern.
  SQLite has no boolean type: store `remote` as `1`/`0`/`NULL`, map back with an
  explicit `row.remote == null ? undefined : row.remote === 1`.

**Postgres** (`schema.sql` + `postgres-mappers.ts` + `postgres-scan-store.ts`):
- `schema.sql` gets `ALTER TABLE postings ADD COLUMN IF NOT EXISTS remote boolean`
  and `... country text` (the file's idempotent-by-design convention).
- `PostingRow` and `PostingInsert` grow `remote: boolean | null` and
  `country: string | null`; `postingToRow`/`rowToPosting` handle them.
- Both the single-row upsert and the bulk `columns` array + value bindings add
  the two columns.

### API (`src/server/app.ts` + repository)

`GET /api/matches` gains two optional query params, parsed leniently:
- `remoteOnly=true` ⇒ only postings where `resolvePostingRemote()` is true.
- `country=<label>` ⇒ only postings whose stored `country` equals the label
  (case-insensitive exact match); absent/empty ⇒ no country filter.

`listScoredPostings(minScore, opts)` extends `ListMatchesOptions` with
`remoteOnly?: boolean` and `country?: string`. **Filtering placement:**
`minScore`, expired, and dismissed stay in SQL (as today). The **country** filter
also goes in SQL (`AND p.country = ? COLLATE NOCASE`) since it's a stored column.
The **remote** filter is applied **in JS after the query**, because
`resolvePostingRemote()` combines the stored `remote` column with the regex
fallback over `location` — semantics SQL can't replicate faithfully. The method
already returns the full row including `location`, so the post-filter is cheap.
Document this split in code comments.

### Web UI (`web/src/api.ts`, `web/src/views/Matches.tsx`)

- `MatchFilters` gains `remoteOnly?: boolean` and `country?: string`.
  `getMatches` sets them in the query string only when truthy (existing
  convention).
- `JobPosting` (web type) gains `remote?: boolean` and `country?: string`.
- `Matches.tsx`: add a **Remote only** checkbox (next to the existing toggles)
  and a **Country** `<select>`. The country options are the distinct, defined
  `country` values across the *currently loaded* results, sorted, with an
  "All countries" default. (Deriving options from results, not a fixed list,
  keeps the dropdown honest — it shows only countries that actually appear.)
- **Remote badge:** `MatchCard` shows a small "Remote" pill when
  `posting.remote` is true. The web layer does **not** reimplement the resolution
  rule — the server sends an already-resolved boolean (see "Resolved remote on
  the wire" below), so the card and the filter both just read `posting.remote`.
  This keeps the regex and the flag-wins logic on the server only — one
  definition, no duplication in the browser bundle.

#### Resolved remote on the wire

To keep one definition of "remote" and avoid shipping the regex to the browser,
the API response includes the **resolved** remote value. `ScoredPosting.posting`
already carries the raw stored fields; the server sets `posting.remote` to
`resolvePostingRemote(posting)` before serializing the matches response, so the
client receives a definitive boolean and the badge/filter just read it. (The raw
stored column is still what's persisted; resolution happens at read time in the
handler/repo mapper.)

### Scoring (`src/matching/`)

The penalty is gated on `resolveRemoteOnly(settings, override)` (existing).

- **`score-run.ts`:** replace the hard filter
  `gated.filter((c) => isRemote(c.posting.location))` with a penalty pass — when
  `remoteOnly` is on, reduce the score of candidates where
  `resolvePostingRemote(posting)` is false. The penalty is applied to the final
  `MatchResult.score` (clamped to ≥ 0). Exact penalty magnitude fixed in the
  plan (a proportional reduction, e.g. multiply by a constant < 1, so a strong
  match that happens to be on-site still ranks above weak matches).
- **`HeuristicScorer`:** the scorer itself stays location-agnostic; the penalty
  is applied uniformly in `score-run.ts` after scoring, so it works identically
  for heuristic and LLM results. (This keeps the penalty in one place rather than
  duplicated in each scorer.)
- **`LlmScorer` prompt (`score-prompt.ts`):** when `remoteOnly` is on, add a
  one-line remote-preference instruction to the cacheable `system` prefix and
  include `Remote: <resolved>` / `Location: <location>` in the per-posting `user`
  message, so the model's own score already reflects the preference. The
  post-scoring penalty in `score-run.ts` still applies as a deterministic floor.
  `MatchPayloadSchema` is unchanged (remote is input, not output).

## Data flow

```
scan → connector.fetchPostings()
         ├─ structured remote? (Lever/Ashby/Rippling/JSON-LD) → MappedJob.remote
         └─ else remote = undefined
     → JobPosting { location, remote? }
     → scan pipeline: country = parseCountry(location)
     → repo.savePosting / scan-store  (persist remote 0/1/null, country text/null)

score → resolveRemoteOnly(settings)
         └─ if on: penalize score where !resolvePostingRemote(posting)
            + LLM prompt remote-preference signal

read  → GET /api/matches?minScore&remoteOnly&country
         ├─ SQL: minScore, expired, dismissed, country
         ├─ JS:  resolvePostingRemote() filter when remoteOnly
         └─ set posting.remote = resolvePostingRemote(posting) on the wire
     → Matches.tsx: Remote toggle, Country dropdown, Remote badge
CLI   → list --min-score --remote-only --country  (same repo path)
```

## Decomposition: four sequential PRs

One spec, four independently-shippable PRs, in order. Each builds on merged
groundwork and is reviewable on its own.

1. **PR 1 — Data model, ATS extraction, persistence.** `remote?`/`country?` on
   `JobPosting`; `resolvePostingRemote`; `parseCountry` (`location-filter.ts`);
   connector schema+mapper updates (Lever, Ashby, Rippling, JSON-LD); `MappedJob`
   threading; country computed in the scan pipeline; SQLite migration + upsert +
   mapper; Postgres schema + mappers + scan-store. *No user-facing change yet;
   columns populate on next scan.*
2. **PR 2 — Remote filter + badge + CLI.** `/api/matches?remoteOnly`; resolved
   `remote` on the wire; `listScoredPostings` remote post-filter; Matches "Remote
   only" toggle; Remote badge on the card; CLI `list --remote-only`.
3. **PR 3 — Country filter + CLI.** `/api/matches?country`; SQL country filter;
   Matches country dropdown (options from results); CLI `list --country`.
4. **PR 4 — Remote-preference scoring penalty.** `score-run.ts` filter→penalty
   change; LLM prompt remote-preference signal; README/behavior-change note.

## Error handling

- Connector remote extraction never throws: a malformed/absent structured field
  yields `undefined`, and resolution falls back to the regex. Existing
  connector-failure-becomes-`Warning` behavior is preserved.
- `parseCountry` returns `undefined` for anything it can't confidently map; it
  never throws and never guesses.
- API params are lenient: unknown `country`, `remoteOnly` other than `"true"`, and
  absent params all degrade to "no filter," matching the existing `minScore`
  handling.
- SQLite migration is idempotent (PRAGMA check); Postgres uses
  `ADD COLUMN IF NOT EXISTS`. Re-running setup on an existing DB is safe.

## Testing strategy

Per PR, colocated and offline (fixtures), matching existing patterns
(`repository.test.ts` uses `new Repository(":memory:")`; `app.test.ts` uses
`app.request()` against an in-memory repo).

- **PR 1:**
  - `remote-filter.test.ts`: `resolvePostingRemote` — flag true/false wins over
    location; undefined flag falls back to regex; blank location ⇒ remote.
  - `location-filter.test.ts`: `parseCountry` — country name, ISO code,
    "Remote - US", US state code/name ⇒ "US", unparseable ⇒ undefined, blank ⇒
    undefined. Table-driven; inputs from fixtures, not hardcoded in `expect`.
  - Connector tests (extend existing `lever.test.ts`, `ashby.test.ts`,
    `rippling.test.ts`, `jsonld.test.ts`): add fixtures with the structured field
    set to remote / on-site / absent; assert the mapped `JobPosting.remote`.
    Assert a regex-only connector (e.g. Greenhouse) leaves `remote` undefined.
  - `repository.test.ts`: save a posting with `remote`/`country`, read it back;
    migrate an existing DB (table without the columns) and confirm the columns
    are added and old rows read as `undefined`.
  - Postgres mapper unit tests (`postgres-mappers.test.ts` if present, else add):
    round-trip `remote`/`country` through `postingToRow`/`rowToPosting`.
- **PR 2:**
  - `app.test.ts`: `GET /api/matches?remoteOnly=true` returns only resolved-remote
    postings; response `posting.remote` is the resolved boolean; non-remote shown
    without the flag.
  - `repository.test.ts`: `listScoredPostings({ remoteOnly: true })` post-filter.
  - Web: badge renders when resolved remote; toggle wires the param (component
    test if the web suite has them, else covered via `api.ts` param construction).
- **PR 3:**
  - `app.test.ts`: `?country=US` filters to US; case-insensitive; absent ⇒ all.
  - `repository.test.ts`: SQL country filter.
  - Web: dropdown options derived from results; selecting one sets the param.
- **PR 4:**
  - `score-run.test.ts`: with `remoteOnly` on, a non-remote posting's score is
    reduced vs. the same posting remote; with `remoteOnly` off, no change;
    score clamped ≥ 0; strong on-site match still beats weak remote match (the
    penalty is proportional, not annihilating).
  - `score-prompt.test.ts`: remote-preference line present in `system` only when
    on; `Remote:`/`Location:` present in `user` message.

## Risks

- **Country parsing is inherently fuzzy.** Mitigation: conservative — only map
  high-confidence cases, return `undefined` otherwise; never drop unknowns;
  dropdown shows only what parsed. The alias/state maps are easy to extend later.
- **SQLite/Postgres drift.** Mitigation: the global constraint that both move
  together; PR 1 touches both in one diff; round-trip tests on each.
- **Behavior change (filter→penalty) could surprise users** who relied on
  `remoteOnly` dropping roles during scoring. Mitigation: documented in PR 4 +
  README; the Matches "Remote only" toggle restores hiding on demand.
- **Resolved-remote-on-the-wire vs stored value.** Mitigation: persist the raw
  column; resolve only at read time in one place (handler/repo mapper) so the
  stored data stays truthful and the client gets one definitive boolean.

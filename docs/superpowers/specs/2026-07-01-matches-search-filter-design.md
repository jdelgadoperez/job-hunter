# Matches Search Filter — Design

**Date:** 2026-07-01
**Branch:** `feat/matches-search-filter`

## Objective

Add a free-text search box to the Matches page filter bar. The user types a term, and the
matches list narrows to postings whose `title`, `company`, `location`, or `description` contain
that term (case-insensitive substring match). Filtering runs server-side via SQL, following the
existing `country` filter pattern end-to-end. The query is committed on Enter or blur (not live
per-keystroke).

## Current State

The Matches page already has a filter bar (added in PR #78) supporting minScore, include-expired,
include-dismissed, remote-only, country, and applied filters. Country is the closest template: it
is read from a query param on the server, passed through `ListMatchesOptions`, and applied as a
SQL clause in `Repository.listScoredPostings`. `remoteOnly` is deliberately filtered in JS after
the query because its fallback logic can't be expressed in SQL — text search does not have that
constraint and is expressible directly in SQL, so it follows the `country` (SQL) pattern.

Relevant locations:

- `web/src/views/Matches.tsx` — filter state + filter bar UI + list rendering.
- `web/src/api.ts` — `MatchFilters` type and `api.getMatches` query-string builder.
- `web/src/hooks.ts` — `useMatches` TanStack Query hook (query key must include all filters).
- `src/server/app.ts` — `GET /api/matches` handler reads query params.
- `src/storage/repository.ts` — `ListMatchesOptions` + `listScoredPostings` SQL builder.

## Proposed Solution

Thread a new `search?: string` option through the same five layers the `country` filter uses.

### 1. Repository (`src/storage/repository.ts`)

- Add `search?: string` to `ListMatchesOptions`.
- In `listScoredPostings`, build a `searchSql` clause mirroring `countrySql`:

  ```sql
  AND (p.title LIKE ? OR p.company LIKE ? OR p.location LIKE ? OR p.description LIKE ?) COLLATE NOCASE
  ```

  Push `%${opts.search}%` onto `params` four times, in the positional order the clause appears
  in the concatenated WHERE string (params are positional and order-sensitive: `minScore` is
  always first, then the existing clauses, so the new params go in the same relative position as
  `searchSql` in the SQL string).
- Splice `searchSql` into the WHERE clause alongside `hideExpired`/`actionSql`/`countrySql`.
- Only build the clause when `opts.search !== undefined`. The caller is responsible for
  normalizing empty/whitespace input to `undefined` (see UI), but the repo also treats a trimmed
  empty string as "no filter" defensively.

### 2. Server (`src/server/app.ts`)

- In `GET /api/matches`, read `const search = c.req.query("search") || undefined;` and pass it
  into the `repo.listScoredPostings` options object, exactly as `country` is handled.

### 3. API client (`web/src/api.ts`)

- Add `search?: string` to `MatchFilters`.
- In `api.getMatches`, add `if (filters.search) params.set("search", filters.search);`.
- No response-schema change — `ScoredPostingSchema` is unchanged, so the api drift test stays
  green.

### 4. Hook (`web/src/hooks.ts`)

- Add `search: filters.search ?? ""` to the `useMatches` `queryKey` object so cache dedup stays
  correct.

### 5. UI (`web/src/views/Matches.tsx`)

- Two pieces of state:
  - `searchInput: string` — the controlled `<input>` value (updates on every keystroke).
  - `search: string | undefined` — the committed term that drives the query.
- A text `<input type="text">` in the filter bar, styled like the existing controls (see
  `web/src/components/ui.tsx` for `control`/`select` classes), placed near the country `<select>`.
- Commit behavior: `onKeyDown` (Enter) and `onBlur` set `search` from `searchInput`, trimmed;
  an empty trimmed string commits `undefined`.
- Include `search` in the `useMatches` filters object.
- Add `search !== undefined` to `filtersAreActive` so the empty-state message ("loosen your
  filters") is accurate when a search returns nothing.

## Error Handling

- Empty or whitespace-only search → treated as no filter (`undefined`), both at the UI commit
  step and defensively in the repository.
- SQL uses parameterized `LIKE` placeholders — no injection risk.
- No schema migration: this is a query-only change, no new columns, no `migrate()` change.

## Testing Strategy

- **`src/storage/repository.test.ts`** — extend with round-trip tests via `savePosting` /
  `listScoredPostings`:
  - a search term matches on `title`, on `company`, on `location`, and on `description`
    (one assertion each, driven by seeded fixture data);
  - matching is case-insensitive;
  - non-matching postings are excluded;
  - `undefined` / empty search returns the unfiltered set.
  No hard-coded expect literals beyond values derived from the seeded fixtures.
- **`web/src/views/Matches.test.tsx`** — typing into the search box and pressing Enter narrows
  the rendered list; clearing the box and committing restores it. `fetch` is mocked per the
  existing web test conventions.
- **`web/src/api.ts` drift test** — remains green; no response-shape change.

## Success Criteria

- A text box appears in the Matches filter bar.
- Entering a term and pressing Enter (or blurring) narrows the list to postings matching on
  title/company/location/description, case-insensitively, via a server round-trip.
- Clearing the term restores the full (otherwise-filtered) list.
- `filtersAreActive` reflects the search so the empty state reads correctly.
- All new and existing tests pass; lint, typecheck, and coverage gates stay green.

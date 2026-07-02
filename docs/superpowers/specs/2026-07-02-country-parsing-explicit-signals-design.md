# Improve country parsing (explicit signals) — Design

## Context

The Matches view shows an "Unknown location" badge on postings whose `country` is `NULL` while a
country filter is active. In practice this fires on a large majority of postings that clearly *have*
a location: "AI Engineer · San Francisco", "Account Executive (SMB) · Austin, Texas",
"criteo · Barcelona" all show "Unknown location".

### Root cause (confirmed)

`parseCountry` in `src/matching/location-filter.ts` is deliberately conservative: it recognizes a
country only when a token, checked end-first, **exactly** equals a known country alias, a 2-letter US
state code, or a 2-letter Canadian province code. It does not recognize:

1. **Full US/Canadian state/province names** — "Texas", "California", "Ontario" (only `tx`, `ca`, `on`).
2. **Country names outside a small hardcoded set** — the aliases cover US/UK/Canada/Germany/France
   only; "India", "Ireland", "Singapore", "Australia", "Brazil", "Spain", "Mexico", "Netherlands",
   "Japan", "United Arab Emirates", "Türkiye", "Switzerland", "Colombia" are all missed.
3. **Signals embedded in a multi-word token** — "Remote US", "US West", "Remote U.S." never split
   into a bare "us" token, so they miss.

### Measured impact (local DB, 2026-07-02)

- 14,881 total postings; only 4,183 (28%) have a parsed country.
- **10,480 postings have a non-empty location but `country IS NULL`.**
- Top recoverable buckets among those: full US state names (~1,021), missing foreign country names
  (~1,216), "Remote - US…" variants (~177), plus many "City, State" / "City, Country" strings.

## Scope decision

**Explicit signals only — no city gazetteer, no guessing.** We add recognition for place names that
are *unambiguously present* in the location string. Bare cities ("San Francisco", "London",
"Scottsdale", "Tokyo") stay `undefined`. This preserves the module's core invariant: *never guess a
country; an unknown country is never invented and never silently dropped from an unfiltered list.*
(Chosen over a curated major-city gazetteer and over a full geo-lookup dependency.)

## Design

### 1. Expand recognized signals (`src/matching/location-filter.ts`)

- **Full US state names → `US`**: add `alabama` … `wyoming`, plus `washington d.c.` /
  `district of columbia`, alongside the existing 2-letter codes. Keep both; either can appear.
- **Full Canadian province/territory names → `Canada`**: `alberta`, `british columbia`, `manitoba`,
  `new brunswick`, `newfoundland and labrador`, `nova scotia`, `ontario`, `prince edward island`,
  `quebec`, `saskatchewan`, plus the territories.
- **Additional country aliases** (canonical label = readable name): `india` → "India",
  `ireland` → "Ireland", `singapore` → "Singapore", `australia` → "Australia", `brazil` → "Brazil",
  `spain` → "Spain", `mexico` → "Mexico", `netherlands` → "Netherlands", `japan` → "Japan",
  `united arab emirates`/`uae` → "United Arab Emirates", `türkiye`/`turkey` → "Türkiye",
  `switzerland` → "Switzerland", `colombia` → "Colombia". Extend as new feeds surface more.

Canonical labels are readable strings (matching the existing "Canada"/"Germany"/"France" style),
except the existing ISO-2 labels ("US"/"UK") which stay as-is because they read well in the dropdown.

### 2. Word-level scan within tokens

After splitting on `,()-–—/;` (the existing set plus `;` — see §4), also split each token on
whitespace and check each **whole word** against the alias / state / province sets. Matching order per token (still iterating tokens
end-first, since the country usually trails the city):

1. whole-token alias  (so multi-word aliases like "united arab emirates", "british columbia",
   "new brunswick" match before word-splitting can break them apart)
2. whole-token US state code / CA province code
3. word-by-word: for each word in the token, alias → US state code → CA province code

First hit wins. This catches "US West" → `us`, "Remote US" → `us`, "Remote U.S." → `u.s.` while
staying **exact-word** (no substring): "business" never matches `us`, "indiana" never matches
`india`.

`"US-CA-Menlo Park"` already splits on `-` into `["US","CA","Menlo Park"]`; end-first, "Menlo Park"
misses and "CA" → US. No special handling needed.

### 3. Backfill via `migrate()` (`src/storage/repository.ts`)

One-time, idempotent backfill following the existing additive-migration pattern:

```
for each posting where country IS NULL and location is non-empty:
    const parsed = parseCountry(location)
    if parsed !== undefined: UPDATE postings SET country = parsed WHERE id = ?
```

Runs automatically on next `serve`/`scan`. Idempotent: a second run finds the already-filled rows no
longer `NULL` (or genuinely-unknown rows still `NULL`), so it changes nothing. Uses the same TS
`parseCountry` — single source of truth, no SQL re-implementation of the matching rules.

Postgres worker/store: out of scope for the backfill (the worker re-derives country from the same
`parseCountry` on its own crawl; only the local SQLite backlog needs the one-time fix). Going-forward
parsing already flows through the shared function.

### 4. Deliberately-unknown cases (invariant preserved)

Stay `undefined` by design:

- **Bare cities**: "San Francisco", "London", "Scottsdale", "Tokyo" — no explicit signal.
- **Multi/ambiguous**: "2 Locations", "3 Locations", "London, Paris, Toronto, New York",
  "London or Paris", "Home based - Worldwide".
- **Region-only without a country word**: "Home based - EMEA" → unknown.
- Add `;` to the token-split delimiter set (currently `,()-–—/`) so semicolon-separated multi-locations
  tokenize cleanly. With `;` added, "APAC - Australia; Singapore" resolves end-first to the last
  country word found (Singapore) — acceptable, since the role *is* in Singapore. Without it, the
  trailing `;` would prevent a match. Note this makes the "first vs last country wins" for
  multi-country strings deterministic (end-first ⇒ the trailing location wins), which is fine.

### 5. False-positive guard

Word matching is **whole-word exact** against the sets, never substring. The one accepted edge:
standalone words that happen to equal a state code — "in" (Indiana), "or" (Oregon), "me" (Maine) —
map to US. Location strings are place labels, not prose, so these appear as codes, not English words;
risk is low. Documented with a test rather than special-cased.

## Testing (TDD, colocated, offline, gate 93/85/90/93)

`src/matching/location-filter.test.ts` — cases driven by real DB samples:

- Full state name → US: "Austin, Texas", "Los Angeles, California", "New York, New York".
- Full province name → Canada.
- New country aliases: "Bangalore, India", "Dublin, Ireland", "Singapore, Singapore",
  "São Paulo, Brazil - Remote", "Dubai, United Arab Emirates - Remote".
- Word-scan: "Remote US" → US, "US West" → US, "Remote U.S." → US, "Remote - US East" → US.
- Semicolon split: "APAC - Australia; Singapore" → Singapore (last country wins, end-first).
- Multi-word alias integrity: "united arab emirates" matches as a token before word-splitting.
- Negative (stay undefined): "San Francisco", "London", "2 Locations", "London or Paris",
  "Home based - Worldwide".
- False-positive guard: a token containing "business"/"indiana" does not resolve via substring.

`src/storage/repository.test.ts` — migration backfill:

- A posting with a now-parseable location ("Austin, Texas") and `country NULL` gets `country = "US"`
  after `migrate()`.
- A posting with a genuinely-unknown location ("San Francisco") stays `NULL`.
- Idempotent: running `migrate()` twice yields the same country values (no double-processing effect).

## Non-goals / flags

- No city gazetteer, no geo-lookup dependency (respects "no unnecessary dependencies").
- No Postgres-side backfill (local SQLite backlog only; worker re-derives on crawl).
- Region labels (EMEA/APAC/Worldwide) are not countries and stay unknown.
- The accepted state-code-word edge (in/or/me) is documented, not eliminated.

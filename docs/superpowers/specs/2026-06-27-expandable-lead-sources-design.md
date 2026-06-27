# Design: Expandable lead sources (framework + Remotive + Workable)

Date: 2026-06-27
Status: Approved (design); pending implementation plan

## Problem

Discovery has exactly one production lead source — the stillhiring.today Airtable directory — plus
user-tracked companies, both hardcoded into `collectLeads` (`src/discovery/discover.ts`). The
exploration doc `docs/career-page-resources.md` (merged via PR #45) catalogues many more sources but
notes "nothing here is wired up yet." Two concrete gaps:

1. There is no seam for adding a new lead source — `collectLeads` reads Airtable inline, so each new
   source would repeat the pattern.
2. **Workable** is the one ATS platform the doc flags with a public feed but **no connector**
   (`detect-ats-fingerprint.ts:52` already lists it as `connectorSource: null`).

## Goals

1. A **`LeadSource` framework** — a registry of sources (mirroring `connectors/registry.ts`) that
   `collectLeads` fans out over, so adding a source is a small, isolated change.
2. A **Remotive source** — the first new source (free, no auth), proving the framework end-to-end.
3. A **Workable connector** — the missing ATS connector, modeled on `LeverConnector`, wired into
   `resolve-ats` and the fingerprint table so any lead pointing at a Workable board resolves to it.
4. **Document The Muse** as the pattern for a key-gated source (do not build it) — so the next
   contributor has a worked example of the key-gating path.

## Non-goals (YAGNI)

- No The Muse / Adzuna / USAJobs / HN sources built (documented as follow-ups).
- No per-source enable/disable settings or CLI (key-gating covers the only current need).
- No board-token collapsing for per-posting sources (noted as a future `resolve-ats` optimization).
- No programmatic enumeration (§4 of the doc) — separate, larger sub-project.

## Source enablement policy

**On by default, key-gated** — mirrors the LLM scorer's no-key fallback:
- No-auth sources (Airtable, Remotive) always run.
- A key-requiring source (The Muse, when built) self-skips when its key setting is unset, returning
  `{ leads: [], warnings: [{ source, message: "no API key configured; skipping" }] }` — never an
  error. No enable/disable UI now.

## The `LeadSource` framework

### Seam (`src/discovery/sources/types.ts`)

```ts
export interface LeadSource {
  /** Stable name, used for warning attribution. */
  readonly name: string;
  fetch(deps: LeadSourceDeps): Promise<LeadSourceResult>;
}

export type LeadSourceResult = { leads: CompanyLead[]; warnings: Warning[] };

export type LeadSourceDeps = {
  fetcher: Fetcher;
  settings: SettingsReader;          // for key-gated sources (Remotive ignores it)
  sharedViewReader: SharedViewReader; // Airtable still needs this
  shareUrl: string;
};
```

`CompanyLead` is unchanged (`{ company, careersUrl, categories }`). `SettingsReader` is the existing
interface from `@app/matching/resolve-settings`. Every source obeys the same contract as today's
Airtable read: **degrade to a `Warning`, never throw.**

### Registry (`src/discovery/sources/registry.ts`)

Mirrors `connectors/registry.ts`: a single shared instance per source and an ordered list.

```ts
export const airtableSource = new AirtableSource();
export const remotiveSource = new RemotiveSource();

/** Lead sources run on every scan, in priority order (earlier wins on URL-dedup collisions). */
export const LEAD_SOURCES: LeadSource[] = [airtableSource, remotiveSource];
```

Order matters only for which lead wins a normalized-URL collision (the dedup is first-wins, as
today). Airtable is first because it's the canonical directory. Categories don't affect discovery —
`airtableRowsToLeads` actually emits empty `categories` (categories are the matcher's job, not
discovery's), so collision precedence is about nothing more than which `company` display name wins;
the careers URL — the only field that drives fetching — is identical by definition of a collision.

### `AirtableSource` (`src/discovery/sources/airtable-source.ts`)

Wraps today's inline Airtable logic from `collectLeads` as a `LeadSource` — reads the shared view via
`sharedViewReader`, maps with the existing `airtableRowsToLeads`, and converts its `mapped.warning`
(plus any thrown error) into the `warnings` array. Pure move of existing behavior; no behavior change.

### `collectLeads` becomes a fan-out (`discover.ts`)

`collectLeads` runs every source in `LEAD_SOURCES`, concatenates their leads with the tracked-company
leads (mapping unchanged), then applies the **existing** `normalizeUrl` dedup (first-wins, unchanged).
Each source is awaited independently; a source that returns warnings contributes them to the result.

`DiscoverDeps` gains `settings: SettingsReader` (threaded to `LeadSourceDeps`). The CLI
(`runScanCommand`) and server (`createScanRunner`) already hold a `SettingsReader` via the repo —
pass `settingsWithEnvKey(repo)` (same value already used for the scorer), so no new user-facing config.

Tracked companies stay merged exactly as today (they are not a `LeadSource` — they're per-user state,
not a directory).

## Remotive source (`src/discovery/sources/remotive.ts`)

`RemotiveSource implements LeadSource`, `name = "remotive"`.

- **Endpoint:** `https://remotive.com/api/remote-jobs` (free, no auth).
- **Response:** `{ jobs: [{ company_name, url, category, candidate_required_location, ... }] }`.
- **Validation:** a `RemotiveFeed` zod schema (sibling to `connectors/schemas.ts`), fetched via the
  shared `fetchFeed(fetcher, url, schema)` boundary so the degrade-never-throw contract is inherited.
  A failed/malformed response → `{ leads: [], warnings: [{ source: "remotive", message }] }`.
- **Granularity — one lead per posting URL:** Remotive returns one row per job, but `CompanyLead` is
  per-company. The source emits **each job's `url` as its own `CompanyLead`** (`company ←
  company_name`, `careersUrl ← url`, `categories ← [category]`). It stays "dumb" about ATS platforms:
  `resolve-ats` + `detect-ats-fingerprint` classify each URL downstream — many Remotive URLs are
  Greenhouse/Lever/Ashby/Workable apply pages that resolve to a connector for free; the rest fall to
  the browser/JSON-LD fallback. The existing normalized-URL dedup collapses repeats safely.
- **Future optimization (not now):** a per-posting source produces many leads pointing at the same
  board. Collapsing them to one board-token lead belongs in `resolve-ats`/dedup, not the source —
  noted here, deferred (YAGNI until per-posting fetching proves wasteful).

## Workable connector (`src/discovery/connectors/workable.ts`)

`WorkableConnector implements AtsConnector`, `source = "workable"`, modeled on `LeverConnector`.

- **Endpoint:** `https://apply.workable.com/api/v3/accounts/{token}/jobs` — public JSON,
  `{ results: [{ title, shortcode, url?, description, location: { city?, region?, country? } }],
  nextPage? }`.
- **Schema:** add `WorkableFeed` to `connectors/schemas.ts`.
- **Mapping:** `title ← title`; `url ← results[].url` when present, else synthesized
  `https://apply.workable.com/{token}/j/{shortcode}` (BambooHR-style fallback); `description ←
  description`; `location ←` joined `city`/`region`/`country` (BambooHR-style `joinLocation`).
- **Pagination — handled inside the connector:** Workable v3 paginates via a `nextPage` cursor. The
  shared `fetchAtsPostings` fetches a single URL, so `WorkableConnector` instead loops `fetchFeed`
  over pages itself, following `nextPage` up to a **cap of 10 pages**, accumulating `results`, then
  stops (logging nothing — partial accumulation is fine). A page fetch that fails returns
  `{ ok: false, warning }` for the whole connector call (consistent with `fetchFeed`); the
  orchestrator records it as a `Warning`. It still normalizes each accumulated job exactly like
  `fetchAtsPostings` does (stable id via `makePostingId({ company: token, title, url })`,
  `company ← token`, `source: "workable"`, single `fetchedAt`).

### Wiring Workable into resolution

- **`resolve-ats.ts`:** add a host case — `host === "apply.workable.com"` → `{ connector:
  workableConnector, boardToken: <first path segment> }`. (Remotive/role URLs like
  `apply.workable.com/{token}/j/{shortcode}` have the token as the first path segment, matching the
  existing `parsed.pathname.split("/").filter(Boolean)[0]` pattern.)
- **`connectors/registry.ts`:** add `export const workableConnector = new WorkableConnector();` and
  include it in `connectorBySource` (its board token **is** re-derivable — it's stamped as each
  posting's `company` — so liveness re-checks can re-fetch the board, unlike Workday/UKG).
- **`detect-ats-fingerprint.ts`:** flip the existing Workable entry (line 52) from
  `connectorSource: null` to `connectorSource: "workable"` (it's now connector-backed, so a page
  embedding `workable.com` reports "just needs a resolve step" rather than "new platform").

## Document The Muse (pattern only — `docs/career-page-resources.md`)

Add a short "Worked example: a key-gated source" subsection showing the shape a key-requiring source
takes against this framework — endpoint `https://api-v2.themuse.com/jobs`, a `THE_MUSE_API_KEY`
setting read from `LeadSourceDeps.settings`, the self-skip-with-warning when unset, and one-lead-
per-listing mapping. No code; it's the template for the next contributor.

## Error handling (degrade, never crash)

- A source that throws or returns a bad payload → caught by `collectLeads` (or self-handled in the
  source) → `Warning`, empty leads, scan continues. Same contract as today's Airtable read.
- Workable page-fetch failure → `{ ok: false, warning }` → orchestrator `Warning`; the lead is
  recorded as failed, the scan continues (existing `discover` loop behavior).
- A key-gated source with no key → empty leads + one informational `Warning`. Never an error.

## Testing (offline, fixture-driven, coverage gate stays green)

- `airtable-source.test.ts` — `AirtableSource` maps a fixture shared-view read to leads + surfaces the
  mapping warning; an unreachable reader degrades to `{ leads: [], warnings: [...] }`.
- `remotive.test.ts` — maps a `remotive-jobs.json` fixture to one lead per job (company/url/category);
  a malformed payload and a non-2xx both degrade to a warning, never throw.
- `registry`/`collectLeads` — fan-out merges multiple sources, dedups by normalized URL with
  first-wins precedence (the earlier-registered source's lead wins a URL collision), tracked
  companies still merged, a failing source doesn't abort the others.
- `workable.test.ts` — maps a `workable.json` fixture (incl. the `shortcode`-only URL fallback and
  `joinLocation`); pagination follows `nextPage` across two fixture pages and stops at the cap; a
  page-fetch failure → `{ ok: false }`.
- `resolve-ats.test.ts` — `apply.workable.com/{token}/...` resolves to `workableConnector` with the
  token; `connectorBySource` includes workable.
- `detect-ats-fingerprint.test.ts` — a page embedding `workable.com` now reports
  `connectorSource: "workable"`.
- All offline; live network stays out of CI (smoke scripts only). Don't hard-code expected values
  derivable from fixtures.

## Out of scope (follow-ups)

- The Muse / Adzuna / USAJobs / HN Who-is-Hiring sources (key-gated or link-extracting).
- Curated token-list sources (§3) and programmatic enumeration (§4).
- Board-token collapsing for per-posting sources.

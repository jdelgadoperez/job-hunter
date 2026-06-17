# Job Hunter — Desktop App Design

**Date:** 2026-06-17
**Status:** Approved (design phase)
**Author:** Jess Delgado Perez (with Claude)

## Objective

A local, private desktop application that helps a person find currently-open job
roles aligned to their skills. It takes a resume and/or role keywords, discovers
open roles via `stillhiring.today` plus company career pages, scores each role
against the person's skills (with a match percentage and skill-gap analysis), and
verifies that each posting is still live (not a stale link). Results are presented
as a ranked, filterable dashboard.

The primary users are the author's two brothers (one on macOS, one on Windows),
who are **non-technical**. The app must therefore be installable by double-click,
require no accounts or server, and keep all personal data on the user's own
machine. The design also accommodates use by others without consuming the author's
API tokens.

## Guiding Constraints

- **Local and private.** No server, no accounts, no login. A user's resume,
  searches, and results never leave their machine. Nothing for the author to host
  or babysit.
- **Non-technical install.** Distributed as a signed `.dmg` (macOS) and `.exe`
  installer (Windows). Double-click to install, double-click to run.
- **Desktop is the workhorse.** iPhone/phone access is explicitly out of scope for
  iteration 1 (see Non-Goals). The architecture must not preclude adding it later.
- **Single language end-to-end.** TypeScript across both the Electron main process
  and the React renderer, sharing the same domain types across the IPC boundary.
- **Degrade, never crash.** Partial failures (a company that can't be scraped, a
  missing API key, an ambiguous liveness check) produce honest partial results and
  visible warnings, never a hard failure.

## Stack & Key Technology Decisions

| Concern | Choice | Rationale |
|---|---|---|
| App shell | **Electron** | Cross-platform double-click desktop app with a bundled local backend; best fit for "local, private, TypeScript." Tauri (Rust) and a hosted PWA were considered and rejected — see below. |
| Backend runtime | **Node.js** (Electron main process) | Intrinsic to Electron; single language across the IPC boundary; Playwright's reference bindings are Node; workload is I/O-bound (ideal for Node's async model). Python (the author's `jt` stack) and Rust were rejected — see below. |
| UI | **React + TypeScript** (renderer) | Interactivity-heavy UI (streaming search progress, client-side sort/filter, optimistic save/dismiss) fits a reactive SPA over Electron IPC. HTMX was considered but fights Electron's grain (no server; needs SSE+Alpine for the reactive parts). |
| Storage | **SQLite** (local file) | Single-file local store in the OS app-data dir; survives upgrades; off any server. |
| Scraping | **Playwright** + ATS JSON APIs | ATS JSON endpoints (Greenhouse/Lever/Ashby) where available — fast, no browser. Playwright headless browser as a fallback for everything else. |
| Skill matching | **Pluggable scorer** (heuristic + LLM) | Local heuristic always available and free; LLM scorer used when an API key resolves. See Matching module. |

### Rejected stack alternatives

- **Tauri + Rust** — smaller binaries and more secure, but Rust is outside the
  author's stack, Playwright support is weaker, and the scraper would likely run as
  a Node sidecar anyway (Node plus Rust glue). The main win (bundle size) is
  immaterial for a personal tool.
- **Hosted PWA** — would reach the iPhone, but reintroduces the server and the
  privacy custody problem the project explicitly rules out.
- **Python backend** (consistency with the `jt` tracker) — packaging a Python
  desktop app for non-technical Mac+PC users is fragile (PyInstaller/py2app +
  signing + bundling Chromium), can only run as an Electron sidecar (shipping
  CPython *and* Node), and the brothers don't run `jt`, so the consistency is
  low-value.
- **HTMX UI** — excellent for hosted, server-rendered apps; in Electron there is no
  server, so HTMX would require standing up a local HTTP server purely to serve
  fragments, and would still need SSE + Alpine to cover streaming progress and
  reactive list filtering. React fits Electron's IPC model directly.

## Architecture Overview

Six independently testable components, each with a single responsibility and a
well-defined interface:

1. **Profile** — resume parse + keyword input → normalized `SkillProfile`
2. **Discovery** — `stillhiring.today` + ATS resolvers → normalized `JobPosting[]`
3. **Matching** — pluggable scorer (heuristic / LLM) → `MatchResult`
4. **Freshness** — verify a posting is still live → `LiveStatus`
5. **Storage** — local SQLite via a thin `Repository` layer
6. **App shell + UI** — Electron main-process orchestration + React renderer over a
   typed IPC surface

### Process boundary

- **Main process (Node):** owns the pipeline, Playwright, SQLite, and API-key
  resolution. The only component with access to secrets, the database, and the
  network.
- **Renderer (React):** pure UI. Holds no secrets, touches no database or network
  directly. Communicates only through the typed IPC surface.

## Shared Domain Types

Every component speaks in these normalized types, shared verbatim across the IPC
boundary:

```ts
type SkillProfile = {
  skills: string[];          // normalized, e.g. ["typescript", "react", "aws"]
  roleKeywords: string[];    // e.g. ["frontend engineer", "full stack"]
  categories: string[];      // e.g. ["Engineering", "Remote"]
  yearsExperience?: number;
};

type JobPosting = {
  id: string;                // stable hash of company + role + url
  company: string;
  title: string;
  url: string;
  source: string;            // "greenhouse" | "lever" | "ashby" | "browser"
  description: string;
  location?: string;
  postedAt?: Date;
  fetchedAt: Date;
};

type MatchResult = {
  score: number;             // 0–100
  matchedSkills: string[];
  missingSkills: string[];   // the gap analysis
  rationale?: string;        // only populated by the LLM scorer
};

type LiveStatus = "live" | "expired" | "unknown";
```

## Component Designs

### 1. Profile — `buildProfile(input) → SkillProfile`

- **Resume path:** parse the uploaded file (PDF, docx, Markdown, or plain text) →
  plain text → extract skills/keywords. Markdown and `.txt` are read directly;
  PDF/docx go through the parsing library. Default
  extraction is a heuristic skill-dictionary match; LLM extraction is used when an
  API key resolves. Manual keywords/categories merge into the result.
- Pure transformation, no network.
- The extracted profile is **editable in the UI** before searching, so a wrong
  parse is correctable.
- **Depends on:** a resume-parsing library; the skill dictionary; (optionally) the
  LLM client.

### 2. Discovery — `discover(profile) → { postings: JobPosting[]; warnings: Warning[] }`

- `stillhiring.today` is used purely as a **company-discovery source**: filter to
  companies matching the profile's categories → produce a list of companies and
  their careers URLs.
- An **ATS resolver** inspects each careers URL and selects a connector:
  - `GreenhouseConnector`, `LeverConnector`, `AshbyConnector` — these expose clean
    JSON endpoints (fast, no browser).
  - `BrowserConnector` (Playwright) — generic fallback that renders the page and
    extracts listings when no known ATS is detected.
- Each connector returns normalized `JobPosting[]`.
- A failure in any one company/connector is logged into `warnings` and skipped —
  it never aborts the run. Partial results are always returned.
- **Politeness:** a concurrency cap and small inter-request delays so the app does
  not hammer any source.
- **Depends on:** the `stillhiring.today` source; the ATS connectors; Playwright.

### 3. Matching — `score(profile, posting) → MatchResult`

A `Scorer` interface with two implementations:

- **`HeuristicScorer`** — normalized skill overlap + keyword/title weighting +
  fuzzy matching (e.g. "node" ≈ "node.js"). Deterministic, local, free. This is
  **always the fallback.**
- **`LlmScorer`** — semantic alignment (e.g. "React" ≈ "frontend") + richer gap
  analysis + a populated `rationale`. Used only when an API key resolves. On any
  LLM error, it falls back to `HeuristicScorer` so a result is always produced.

**API-key resolution** (in one place, testable):

```
user-provided key (Settings)  →  baked-in key (author's brothers' build)  →  heuristic
```

- The brothers' build bakes in the author's key, giving them smart matching for
  free on volume the author controls.
- A public build ships **no** baked-in key, so other users either provide their own
  key (their own tokens) or fall back to the free heuristic. The author's tokens
  are never consumed by others.

### 4. Freshness — `checkLiveness(posting) → LiveStatus`

- Re-fetches the posting URL to determine current status:
  - **ATS JSON endpoints** answer definitively: present in the feed → `live`; gone →
    `expired`.
  - **Browser-sourced postings:** detect 404 / redirect-back-to-board and
    "no longer accepting applications" markers → `expired`; otherwise `live`.
  - Ambiguous cases → `unknown` (shown honestly, never guessed `live`).
- Directly answers the "is this link stale?" requirement.

### 5. Storage — local SQLite via a `Repository` layer

- One SQLite file in `app.getPath('userData')` so it survives upgrades and stays
  off any server.
- Tables: `profiles`, `search_runs`, `postings`, `match_results`, `user_actions`
  (saved/dismissed), `settings`.
- The API key is stored via the OS keychain (Electron `safeStorage`), **not**
  plaintext in SQLite.
- All access goes through a thin `Repository` layer — no inline SQL elsewhere — so
  storage is swappable and testable against a temp database.

### 6. App shell + UI

**IPC surface (typed, minimal):**

- `startSearch(profile)` — kick off the pipeline
- `onSearchProgress(cb)` — stream progress events to the UI
- `saveRole(id)` / `dismissRole(id)`
- `recheckLiveness(id)`
- `getSettings()` / `setApiKey(key)`

**React screens:**

1. **Onboarding** — upload a resume and/or enter keywords/categories → review and
   edit the extracted `SkillProfile`.
2. **Results dashboard** — ranked cards showing match %, matched skills, gaps, a
   live/expired/unknown badge, and save/dismiss/open actions. Client-side sort and
   filter. Live progress indicator while the search runs.
3. **Settings** — optional personal API key, scraping concurrency/politeness, and a
   data-reset control.

**Pipeline orchestration:** Discovery → (per posting, parallel within concurrency
limits) Matching + Freshness → persist → stream to the UI. The run is long-running
and streams progress rather than blocking.

## Error Handling

The system degrades gracefully and never hard-crashes:

- **Per-company/connector failure** → skipped, collected into a visible
  "couldn't check N companies" warning; partial results still display.
- **LLM failure or no key** → silent fallback to the heuristic scorer.
- **Ambiguous liveness** → `unknown`, shown honestly (never guessed `live`).
- **Resume parse failure** → fall back to manual keyword entry with a clear message.
- **Network offline** → heuristic scoring still works against already-stored
  postings.

## Testing Strategy

- **Unit (core logic):** `HeuristicScorer`, skill extraction, profile
  normalization, ATS-response parsing, and freshness detection — pure functions
  tested against **recorded fixtures** (saved Greenhouse/Lever/Ashby JSON, sample
  HTML, sample resumes). No live network in tests.
- **Connector contract tests:** each ATS connector against its captured fixture,
  asserting normalized `JobPosting` output.
- **Repository tests:** against a temp SQLite file.
- **IPC/integration:** the orchestration pipeline with mocked connectors and
  scorer, asserting progress events and persisted results.
- **LLM scorer:** tested with a mocked client (deterministic), plus an explicit
  test proving that an LLM error yields a heuristic result. No real tokens are
  spent in tests.
- **Live scraping** stays out of the automated suite (flaky and impolite); a
  separate opt-in manual smoke script hits real endpoints to verify connectors
  still work when desired.

## Iteration 1 Scope

Included:

- macOS + Windows desktop app, double-click install, no accounts, all data local
- Input: paste keywords/categories and/or upload a resume (PDF, docx, Markdown, or
  plain text) to auto-extract skills (editable before searching)
- Discovery via `stillhiring.today` → resolve each company's job board
  (Greenhouse / Lever / Ashby, with a generic browser fallback)
- Match % + matched skills + skill gaps per role
- "Still live?" freshness check per posting
- Ranked results dashboard: filter, sort, save, dismiss, open-in-browser
- Settings screen with an optional personal API key

## Non-Goals (deferred to later iterations)

- iPhone / PWA access and cross-device sync
- Public distribution polish (broad marketing, auto-update infrastructure)
- Exotic ATSes (Workday, Taleo, iCIMS, etc.)
- Scheduled / automatic background re-searching
- Export into the author's `jt` application-tracker CLI

## Success Criteria

- A non-technical user can install the app by double-click on macOS or Windows and
  run a search without any terminal or configuration.
- Given a resume or a set of keywords, the app returns a ranked list of open roles
  with a match percentage and a visible skill-gap breakdown.
- Each result shows an honest live / expired / unknown status, so stale links are
  identifiable.
- A failure to scrape some companies yields partial results plus a visible warning,
  not a crash.
- The brothers' build performs LLM-quality matching with no setup; a public build
  works on the heuristic scorer with no key and never consumes the author's tokens.
- All personal data remains in a local SQLite file; the API key is stored in the OS
  keychain.

# CLI Scan Engine & Local Web App — Roadmap + Plan 4

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement Plan 4 task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Direction change (supersedes the deferred Electron/UI plans)

The product is now a **local-first CLI + web app**, not an Electron desktop app:

- **`job-hunter scan`** is the engine: it populates SQLite by discovering companies (the stillhiring.today **Airtable** share, rendered with Playwright, + user-tracked companies), fetching each one's postings, scoring them with the Plan 3 LLM scorer, and storing ranked matches.
- **`job-hunter serve`** starts a small **Hono** server that reads SQLite, serves a **React** app (Vite + Tailwind + ShadCN + TanStack Router/Query), and — because the experience is **browser-first** — exposes endpoints to trigger a scan (with live progress), manage settings, upload a resume, and read matches.
- The target user is a **non-engineer**: after launching once, everything happens in the browser. Runs on **macOS (Intel + Apple Silicon)** and **Windows 11+**.

```
┌─ job-hunter scan ──────────────────────────────────────────────┐
│ Airtable share (Playwright)  ┐                                  │
│ tracked companies (SQLite)   ├─► leads ─► resolve ATS / render  │
│                              ┘            careers page          │
│   ─► normalize ─► freshness ─► LLM score (Plan 3) ─► SQLite     │
└────────────────────────────────────────────────────────────────┘
        │ reads
┌─ job-hunter serve (Hono) ──────────────────────────────────────┐
│  GET /api/matches, /api/companies …   POST /api/scan (SSE)      │
│  serves the built React app (Vite + Tailwind + ShadCN + TanStack)│
└────────────────────────────────────────────────────────────────┘
        │ http
   Browser: onboarding wizard, "Scan now" + progress, ranked matches
```

### Why this resolves the blockers we hit
The egress-allowlist and Airtable API-token walls were **sandbox/auth** problems, not real-world ones. A Playwright CLI runs on the user's own machine, launches a real Chromium, and reads the **public** Airtable share exactly as a browser does — no API token, no collaborator access, no `api.airtable.com`. LinkedIn/Indeed stay **out of scope** (auth + bot-detection + ToS), CLI or not.

## Roadmap

| Plan | Scope | Status |
|---|---|---|
| **4 (this doc, detailed)** | CLI scan engine: Playwright runtime, Airtable shared-view source (replaces the dead JSON connector), tracked companies, cross-platform config, `scan`/`track`/`profile`/`list` commands | Ready to implement |
| **5 (outline below)** | Hono local server: JSON read API over SQLite, `POST /api/scan` with SSE progress, settings + resume-upload endpoints, serves the React build | Outline |
| **6 (outline below)** | React app: Vite + Tailwind + ShadCN + TanStack Router/Query — onboarding wizard, matches dashboard, companies, settings | Outline |

> Packaging/distribution to non-engineers (a one-click installer / standalone binary per OS, bundling Node + Chromium) is a **later concern** noted in Out of Scope — Plans 4–6 assume the user has Node installed and runs `npm`/`npx`.

---

# Plan 4 — CLI Scan Engine + Playwright Runtime

**Goal:** Make `job-hunter scan` a working, cross-platform engine that populates SQLite end to end, replacing the **dead** stillhiring JSON connector (it points at `https://stillhiring.today/api/companies.json`, which does not exist — the site is an embedded Airtable, so discovery currently returns zero companies in production while green tests run against a synthetic fixture). Add a Playwright-rendered Airtable shared-view source, user-tracked companies, cross-platform data paths, and a thin CLI that drives the existing headless engine (discovery → connectors → normalize → freshness → Plan 3 scorer → storage). Still **no server and no UI** — those are Plans 5–6.

**Architecture:** The entire Plan 1–3 engine is reused unchanged. New code is injected behind the existing seams (`Fetcher`, `PageRenderer`, `LlmClient`, `SettingsReader`): a production **Playwright `PageRenderer`** (promoted from the smoke script), a **`SharedViewReader`** seam whose Playwright implementation captures the Airtable embed's own `readSharedViewData` network response (so we never reverse-engineer Airtable's `accessPolicy`), and a `Repository`-backed tracked-companies store. Acquisition (Playwright, network) stays as untested production edges exercised only by opt-in smoke scripts — exactly like `HttpFetcher`; the data transforms (rows → leads, args → actions) are **pure and unit-tested**.

**Tech stack additions:** Playwright (already a devDependency) becomes a runtime renderer. A tiny arg parser for the CLI (`node:util` `parseArgs` — zero new deps). better-sqlite3, p-limit, zod, the Anthropic SDK all carry over.

## Global Constraints

- **Inherit Plans 1–3 constraints:** TypeScript strict ESM, no `any`, no non-null `!`, `node:`-prefixed core imports, extensionless relative imports + `@app/*` alias, colocated `*.test.ts`, Biome-clean, Conventional Commits.
- **Cross-platform (macOS Intel/ARM, Windows 11+) is a first-class constraint:**
  - All file locations resolved via `node:os` + `node:path` — never hard-coded `/` paths. Data dir defaults to `~/.job-hunter/` (macOS) / `%APPDATA%\job-hunter\` (Windows), overridable by env.
  - `better-sqlite3` must resolve to **prebuilt binaries** for `darwin-x64`, `darwin-arm64`, and `win32-x64` (verify on install; document the Windows build-tools fallback if a prebuild is missing).
  - Playwright Chromium via `npx playwright install chromium` (documented prerequisite; works on all three targets).
  - npm scripts stay shell-portable (no bash-only constructs); no reliance on a POSIX shell at runtime.
- **No live network / no real browser in the automated suite.** Playwright and any network call live behind a seam; unit tests use fakes/fixtures. The real Playwright paths run only in opt-in smoke scripts.
- **Don't build against an assumed feed shape (the lesson from the dead connector).** The `readSharedViewData` mapping must be written and tested against a **real captured response** (obtained by running the Playwright reader once on a machine with network), saved as a fixture — not an invented JSON shape.
- **Degrade, never crash.** A source failure (Airtable unreachable, a careers page that won't render) becomes a `Warning` and partial results, never an aborted scan — consistent with the existing `discover()` contract.

---

### Task 1: Cross-platform data paths & runtime config

**Files:** create `src/runtime/paths.ts`; test `src/runtime/paths.test.ts`.

**Interfaces:**
- `DATA_DIR_ENV = "JOB_HUNTER_HOME"` (override).
- `resolveDataDir(env?: NodeJS.ProcessEnv): string` — `JOB_HUNTER_HOME` if set, else `%APPDATA%\job-hunter` on Windows (`process.platform === "win32"`, falling back to `os.homedir()`), else `path.join(os.homedir(), ".job-hunter")`.
- `resolveDbPath(env?): string` — `path.join(resolveDataDir(env), "jobhunter.db")`.
- `ensureDataDir(env?): string` — creates the dir (recursive) and returns it.

**Contract:** Windows env yields an `%APPDATA%`-based path; non-Windows yields a `~/.job-hunter` path; `JOB_HUNTER_HOME` overrides both; paths are built with `path.join` (no literal separators). Tests inject a fake `env` + `platform` rather than touching the real FS where possible (use a temp dir for `ensureDataDir`).

- [ ] Step 1: failing tests for each branch (win32 / posix / override). Step 2: run → red. Step 3: implement with `node:os`/`node:path`/`node:fs`. Step 4: green. Step 5: commit — `feat: cross-platform data directory and db path resolution`.

---

### Task 2: Tracked-companies storage

**Files:** edit `src/storage/schema.ts` (+ `repository.ts`); test `src/storage/repository.test.ts` (extend).

**Interfaces (on `Repository`):**
- New table `tracked_companies (careers_url TEXT PRIMARY KEY, name TEXT, added_at TEXT DEFAULT (datetime('now')))`.
- `addTrackedCompany(careersUrl: string, name?: string): void` — upsert by URL.
- `listTrackedCompanies(): { careersUrl: string; name?: string }[]`.
- `removeTrackedCompany(careersUrl: string): boolean` — returns whether a row was deleted.

**Contract:** add → list returns it; adding the same URL twice doesn't duplicate (upsert, updates name); remove returns `true` then `false`. Round-trips through `:memory:`.

- [ ] Step 1: failing tests. Step 2: red. Step 3: implement (schema + methods). Step 4: green. Step 5: commit — `feat: store user-tracked companies in the repository`.

---

### Task 3: Airtable shared-view source (pure mapping + seam)

**Files:** create `src/discovery/sources/airtable.ts`, `src/discovery/sources/airtable.test.ts`, and a fixture `src/discovery/sources/__fixtures__/airtable-shared-view.json` (a **real** captured `readSharedViewData` response — see Task 4 / smoke).

**Interfaces:**
- `type SharedViewData = { ... }` — zod schema for the relevant slice of a `readSharedViewData` response (`table.columns[{id,name,type}]`, `table.rows[{id, cellValuesByColumnId}]`), validated at the boundary.
- `interface SharedViewReader { read(shareUrl: string): Promise<unknown> }` (raw JSON in; mapping validates).
- `class FakeSharedViewReader implements SharedViewReader` — returns canned JSON (or throws).
- `airtableRowsToLeads(raw: unknown, opts?: { companyField?: string; careersUrlField?: string }): { leads: CompanyLead[]; warning?: string }` — validates with zod, resolves the careers-URL column by name (default **`"Jobs Page"`**) and the company column (default the table's **primary/first** column, observed name `"™"`), maps rows → `CompanyLead` (skipping rows with no careers URL), and **drops the category pre-filter** (the Airtable has no clean category column; ranking is the matcher's job). On a validation failure returns `{ leads: [], warning }`.
- `AIRTABLE_SHARE_SETTING = "airtableShareUrl"` — the share URL lives in settings.

**Contract:** given the real fixture, returns leads with `company` from the primary column and `careersUrl` from `Jobs Page`; rows missing a careers URL are skipped; a malformed payload degrades to `{ leads: [], warning }`. Pure and deterministic.

- [ ] Step 1: capture a real `readSharedViewData` response (Task 4 smoke) and commit it as the fixture; write failing mapping tests against it. Step 2: red. Step 3: implement schema + mapping + `FakeSharedViewReader`. Step 4: green. Step 5: commit — `feat: map airtable shared-view rows to company leads`.

---

### Task 4: Playwright runtime — renderer + shared-view reader (smoke-only)

**Files:** create `src/net/playwright-renderer.ts` (promote `PlaywrightRenderer` out of the smoke script, implementing the existing `PageRenderer`) and `src/discovery/sources/airtable-playwright.ts` (`PlaywrightSharedViewReader implements SharedViewReader`). No unit tests (network/browser edge, like `HttpFetcher`); covered by Task 7 smoke.

**Interfaces:**
- `PlaywrightRenderer implements PageRenderer` — `render(url): Promise<string>` launching Chromium, returning page HTML; reused by the browser fallback connector.
- `PlaywrightSharedViewReader.read(shareUrl)` — opens the share/embed URL and **captures the `readSharedViewData` response** the page issues (`page.waitForResponse(u => u.includes("readSharedViewData"))` → `response.json()`), so Airtable's own page supplies the `accessPolicy`. Returns the parsed JSON.

**Contract:** verified by the smoke script only. Keep all Playwright/Chromium specifics inside these files.

- [ ] Step 1: implement both. Step 2: run the Task 7 smoke locally to capture a real response → save the Task 3 fixture. Step 3: commit — `feat: add playwright renderer and airtable shared-view reader`.

---

### Task 5: Rewire `discover()` — merge Airtable + tracked leads

**Files:** edit `src/discovery/discover.ts`; test `src/discovery/discover.test.ts` (extend). Delete/retire `src/discovery/sources/stillhiring.ts` (+ its fixture/test).

**Interfaces:** `DiscoverDeps` gains `sharedViewReader: SharedViewReader`, `shareUrl: string`, and `trackedCompanies: { careersUrl: string; name?: string }[]`. `discover()` builds leads from `airtableRowsToLeads(await reader.read(shareUrl))` **merged with** the tracked companies, **deduped by normalized careers URL**, then runs the existing resolve/fetch/score pipeline. No category filter.

**Contract:** with a `FakeSharedViewReader` + a `FakeFetcher`/fake renderer, Airtable leads and tracked companies both reach the pipeline; duplicate URLs collapse; an unreachable Airtable degrades to tracked-only + a `Warning`; the existing partial-results/warnings behavior holds.

- [ ] Step 1: failing tests with fakes. Step 2: red. Step 3: rewire; remove stillhiring. Step 4: green. Step 5: commit — `feat: discover from airtable share and tracked companies`.

---

### Task 6: CLI entry point + commands

**Files:** create `src/cli/main.ts` (+ `bin` entry in `package.json`: `"job-hunter": "dist/cli/main.js"` or a tsx shim for dev), `src/cli/commands/*.ts`, and tests for the pure command handlers (`src/cli/commands/*.test.ts`).

**Interfaces / commands** (parsed with `node:util` `parseArgs`; handlers take injected deps so they're testable with an in-memory `Repository` + fakes):
- `job-hunter scan` — load profile + settings from the Repository, build deps (Playwright renderer + reader, `HttpFetcher`, `resolveScorer` from Plan 3), run `discover()`, persist postings + match results, print a ranked summary + warnings.
- `job-hunter track add <careersUrl> [--name <n>]` / `track list` / `track remove <careersUrl>`.
- `job-hunter profile <resumePath>` — build a `SkillProfile` via Plan 1 and save it.
- `job-hunter list [--min-score N]` — print stored matches (a minimal text view; the rich view is the web app).
- Config resolution: settings come from the Repository (`SettingsReader`); `ANTHROPIC_API_KEY` env is honored as a fallback so the CLI works before the web settings page exists.

**Contract:** command handlers are unit-tested with an in-memory repo + fake engine deps — `track`/`profile`/`list` assert storage effects and printed output; `scan` is tested with a `FakeSharedViewReader` + `FakeFetcher` + `FakeLlmClient` end to end (no network/browser). Arg parsing maps flags to handler inputs; unknown commands print usage.

- [ ] Step 1: failing handler tests. Step 2: red. Step 3: implement parser + handlers + wiring. Step 4: green; `npm run typecheck` + lint clean. Step 5: commit — `feat: add job-hunter cli (scan, track, profile, list)`.

---

### Task 7: Opt-in smoke scripts

**Files:** `scripts/smoke-airtable.ts` (live `PlaywrightSharedViewReader` against the real share → prints leads, and is the source of the Task 3 fixture) and `scripts/smoke-scan.ts` (full local `scan` against a temp DB with a real key). npm scripts `smoke:airtable`, `smoke:scan`; excluded from CI.

- [ ] Step 1: write both; run locally (network + `ANTHROPIC_API_KEY`) to validate the live paths and capture the fixture. Step 2: commit — `chore: add opt-in airtable + scan smoke scripts`.

---

## Self-Review

- **Fixes the real bug:** the dead stillhiring JSON connector is removed; discovery sources from the live Airtable share + tracked companies. ✅
- **Cross-platform:** all paths via `node:os`/`node:path`; better-sqlite3 prebuilt-binary + Playwright-install prerequisites documented; npm scripts portable. ✅
- **Reuses Plans 1–3 unchanged** behind existing seams; only the discovery source and the runtime entry points are new. ✅
- **No assumed feed shape:** the Airtable mapping is tested against a real captured fixture, not an invented one. ✅
- **No network/browser in CI:** Playwright + network behind seams; smoke-only live paths. ✅

**Out of scope (later plans):**
- The Hono server + JSON API + SSE scan progress + settings/upload endpoints → **Plan 5**.
- The React app (Vite + Tailwind + ShadCN + TanStack) → **Plan 6**.
- Packaging/distribution for non-engineers (one-click installer / standalone binary bundling Node + Chromium per OS) → later.
- LinkedIn/Indeed and any aggregator scraping → explicitly dropped.

---

## Plan 5 (outline) — Hono local server

`job-hunter serve` starts a Hono server that: serves the built React app (static), exposes a read API over the `Repository` (`GET /api/matches?minScore=`, `/api/companies`, `/api/profile`, `/api/settings`), a **`POST /api/scan`** that runs the engine and streams progress via **SSE**, settings writes (`PUT /api/settings` — Anthropic key, model, Airtable share URL, stored in SQLite settings; plaintext for now, keychain deferred), and a resume upload (`POST /api/profile` → Plan 1 builder). Cross-platform browser-open on launch. Engine deps reuse Plan 4. Pure route handlers unit-tested against an in-memory repo + fake engine; the listening server is smoke-only.

## Plan 6 (outline) — React app

Vite + React + Tailwind + ShadCN + TanStack Router + TanStack Query, built to static assets the Hono server serves. Views: **Onboarding wizard** (paste Anthropic key, paste Airtable share URL, upload resume, run first scan), **Matches dashboard** (ranked, filter by score/freshness/skills, posting detail with rationale + matched/missing skills), **Companies** (Airtable directory + tracked, add/remove tracked by URL), **Settings**. "Scan now" button → `POST /api/scan` with a live progress indicator off the SSE stream. Built minimally, adding ShadCN/Router/Query pieces only as views require — per "if and as needed."

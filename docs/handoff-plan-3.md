# Handoff — continue from Plan 2 (merged)

Use this to pick up `job-hunter` in a fresh session. Paste the prompt below (or
just point the new session at this file).

---

**Project: `job-hunter` — continue from Plan 2 (just merged)**

I'm building a headless job-hunting engine in TypeScript (strict ESM, Node 22).
Repo: `jdelgadoperez/job-hunter`. **PR #3 (Plan 2) is merged into `main`** — start
by syncing `main`.

**Where things stand:**
- **Plan 1 (merged):** pure core domain library + Biome/Vitest/tsc toolchain + CI.
- **Plan 2 (merged, PR #3):** network-bound layer — `Fetcher` seam
  (`HttpFetcher`/`FakeFetcher`), ATS connectors (Greenhouse/Lever/Ashby) returning a
  discriminated `ConnectorResult` via a shared `src/discovery/connectors/fetch-feed.ts`,
  ATS resolver, browser/JSON-LD fallback (`PageRenderer` seam), stillhiring.today
  source, discovery orchestrator (concurrency cap + politeness delay, partial results),
  liveness fetch feeding `detectLiveness`, PDF/docx resume parsing, opt-in smoke script,
  SQLite-seeded skill taxonomy, externalized expired-page markers. **87 tests, CI green.**

**Plans/specs live in:** `docs/superpowers/plans/` and `docs/superpowers/specs/`. Read
the design spec and the Plan 2 plan doc there to refresh full context before doing
anything.

**Next up — Plan 3: LLM scorer + API-key resolution.** No plan doc exists yet. The
existing `Scorer` interface and `HeuristicScorer` are in `src/matching/`; the
`Repository` (`src/storage/`) has `getSetting`/`setSetting` and a `settings` table.

**Important — clarify before implementing.** Do NOT start writing code until you've
asked me about the open design decisions and I've answered. At minimum, ask about:
- LLM provider/model and SDK (default to the latest, most capable Claude — e.g.
  `claude-opus-4-8` — unless I say otherwise);
- where the API key comes from (env var vs. the `settings` table via `Repository`) and
  how it's resolved/validated;
- the network seam for testing the scorer (mirror the `Fetcher` dependency-injection
  pattern so tests run with no live API calls / recorded fixtures);
- prompt shape and the structured output contract that maps to `MatchResult`;
- fallback behavior when no key is configured or the API fails (degrade to
  `HeuristicScorer`? emit a `Warning`?);
- cost/caching/rate-limit concerns.

Then **write the Plan 3 implementation plan** (task-by-task, TDD, checkbox format
matching the existing plan docs) and check it with me before implementing.

**Conventions (match existing code):** TypeScript strict, no `any`/non-null `!`,
`node:`-prefixed core imports, extensionless relative imports + `@app/*` alias (vitest +
tsconfig), colocated `*.test.ts`, Biome-clean (double quotes, 2-space, 100 width),
Conventional Commits, no live network in tests (inject fakes, validate external data
with zod). Run `npm run lint && npm run typecheck && npm test` before committing.

**Workflow:** develop on a new feature branch off `main`, commit incrementally, push,
open a **draft PR**, then watch it for CI/review activity until merged.

---

## Roadmap (from the design spec)
- **Plan 3:** LLM scorer + API-key resolution.
- **Plan 4:** Electron main process + tRPC-over-IPC + pipeline orchestration
  (discovery → matching → freshness → storage).
- **Plan 5:** React UI + signed packaging.

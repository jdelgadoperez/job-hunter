# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-first job-search engine. It discovers open roles from the
[stillhiring.today](https://stillhiring.today) company directory plus user-tracked companies,
scores each posting against the user's resume (Claude LLM, with a free offline heuristic fallback),
and stores ranked matches in a local SQLite DB. It ships as both a CLI (`job-hunter scan`) and a
local web dashboard (`job-hunter serve`) backed by the same database. See `README.md` for the
user-facing guide.

## Commands

```bash
npm test               # vitest run (entire suite)
npm run test:watch     # watch mode
npm run test:coverage  # with the CI coverage gate (see thresholds below)
npm run test:web       # web dashboard tests (jsdom + React Testing Library, web/vitest.config.ts)
npm run typecheck      # tsc --noEmit (server + CLI)
npm run typecheck:web  # tsc for the web dashboard (web/tsconfig.json)
npm run lint           # Biome check (lint + format)
npm run lint:fix       # Biome auto-fix
npm run build:web      # build the dashboard to web/dist
npm run dev:web        # dashboard with hot reload (proxies /api to a running `serve`)
npm run cli -- <cmd>   # run the CLI in dev (e.g. scan, list, profile, track, serve); `--` forwards flags
```

Run a single test file or test:

```bash
npx vitest run src/discovery/discover.test.ts          # one file
npx vitest run src/discovery/discover.test.ts -t "name" # one test by name
```

CI runs lint → typecheck → typecheck:web → test:coverage → test:web → build:web (`.github/workflows`).
Match `.nvmrc` (Node 24; 22+ required).

### Opt-in, network/browser-bound smoke scripts (excluded from CI and coverage)

```bash
npm run smoke:airtable   # read the live Airtable directory (WRITE_FIXTURE=1 refreshes the fixture)
npm run smoke:scorer     # exercise the live LLM scorer (needs ANTHROPIC_API_KEY)
npm run smoke:scan       # a full live scan against a throwaway DB
```

## Architecture

The pipeline is `discover → score → store`, orchestrated by `runScan` in `src/cli/commands.ts`.
Everything below it is dependency-injected so the unit suite runs offline against fixtures — no
real browser, no live network.

- **`src/discovery/`** — finds companies and their postings. `discover.ts` merges the Airtable
  directory (`sources/airtable.ts`, read live via Playwright in prod) with user-tracked companies,
  de-dups by normalized careers URL, then for each lead either resolves a known ATS connector
  (`resolve-ats.ts`) or falls back to rendering the page in a browser (`connectors/browser.ts`).
  Hosts we deliberately don't scrape (LinkedIn/Indeed — see `unscrapable.ts`) are skipped and
  surfaced for manual review. Failures become `Warning`s; discovery never throws.
- **`src/discovery/connectors/`** — per-ATS adapters (Greenhouse, Lever, Ashby via public feeds;
  Workday via a careers URL). Shared singleton instances live in `registry.ts`; add a new connector
  there. Each connector is stateless and used by both URL resolution and liveness re-checks.
- **`src/matching/`** — scoring. `resolve-scorer.ts` picks an `LlmScorer` (when an API key is
  configured) or the free `HeuristicScorer`. The `LlmScorer` wraps the heuristic as a fallback, so
  a failed LLM call degrades to keyword scoring + a warning rather than crashing. Provider/model
  config in `resolve-settings.ts` + `llm-providers.ts`.
- **`src/freshness/`** — posting liveness. After a scan, postings not seen this run are re-fetched
  and expired immediately if confirmed gone (`detect-liveness.ts`); inconclusive ones fall to the
  consecutive-miss heuristic (`repo.expireStalePostings`).
- **`src/profile/`** — resume → skill profile. `read-resume.ts` parses `.pdf`/`.docx`/`.md`/`.txt`;
  `build-profile.ts` extracts skills against the skill dictionary (`src/domain/`).
- **`src/storage/repository.ts`** — the single `Repository` over `better-sqlite3`. Owns the schema
  (`schema.ts`), an idempotent `migrate()` for additive columns, scans as incremental units (directory
  snapshot + diff, posting upsert/expire), settings, and the skill dictionary.
- **`src/server/`** — `app.ts` builds the Hono app (pure, unit-tested); `serve.ts` binds the
  listener; `scan-runner.ts`/`scan-job.ts` run scans as a background job with live progress polled
  via `/api/scan/status`. The server binds to loopback only and rejects non-loopback `Host` headers
  (DNS-rebinding guard).
- **`src/net/`** — `fetcher.ts` (HTTP), `playwright-renderer.ts` (browser), `ssrf-guard.ts`,
  `with-timeout.ts`.
- **`src/runtime/`** — data paths (`paths.ts`: `~/.job-hunter/jobhunter.db`, overridable with
  `JOB_HUNTER_HOME`), version + update check, setup config.
- **`web/`** — Vite + React 19 + Tailwind v4 + TanStack Query dashboard. Static build served by the
  Hono server. All data comes from `/api/*` (`web/src/api.ts`).

## Conventions

- **TypeScript-strict, ESM**, `target` ES2022, `moduleResolution: bundler`. `noUncheckedIndexedAccess`
  and `noImplicitOverride` are on. Import server/CLI code via the `@app/*` alias (→ `src/*`).
- **Biome** for lint + format: 2-space indent, 100-col width, double quotes. Run `npm run lint:fix`
  before committing.
- **Tests are colocated** (`*.test.ts` next to source) and offline by design — dependencies are
  injected and fed fixtures (`__fixtures__/`). Anything network/browser-bound is excluded from the
  coverage gate and covered only by `smoke:*` scripts.
- **Web tests** live next to their source under `web/src/` (`*.test.ts`/`*.test.tsx`) and run under
  jsdom + React Testing Library via `web/vitest.config.ts` (`npm run test:web`). `fetch` is mocked —
  they never hit a real server. The `api.ts` zod schemas are the client/server contract guard: a
  drift test there fails loudly instead of leaking `undefined` into the UI.
- **Coverage gate** (vitest.config.ts): statements 93 / branches 85 / functions 90 / lines 93. New
  code should keep these green; raise the floor as coverage climbs rather than lowering it.
- **Failures degrade, never crash.** Discovery and scoring collect `Warning`s and return partial
  results — preserve this when touching the scan pipeline. A single company or a failed LLM call
  must not abort a scan.
- **Commits:** Conventional Commits. Do NOT add a Claude co-authored footer.

# Hosted Scan Backend — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the shared **sourcing** half of the pipeline once, centrally, and serve a deduplicated posting feed — so the local app pulls postings instead of crawling, killing the per-user duplicated crawl. Scoring stays on the client (privacy preserved). This realizes Phases 1–2 of `docs/sourcing-backend-exploration.md` for the **shared read-feed** v1 (no accounts).

**Decisions (locked):** v1 = shared read-feed; host = **Supabase Postgres + auto REST (PostgREST) for data**, **a container/cron worker for the Playwright crawl**. Phase 0.5 (decouple scan from score) is already merged (#46), so this is additive.

**Architecture:**
- A new **sourcing-only** run (`runSourcing`) is extracted from `runScan` (discover → persist → liveness → finish, *without* scoring). Local `scan` becomes `runSourcing` + the existing heuristic-scoring step; the **worker** calls `runSourcing` against Postgres.
- `runSourcing`/liveness depend on a structural **`ScanStore`** (the sourcing subset of `Repository`), so the same pipeline writes to SQLite (local) or Postgres (worker) unchanged.
- The **worker** (`src/backend/scanner/`) wires `discover()` + a `PostgresScanStore` and runs on a schedule (Fly.io/Railway cron or a scheduled GitHub Action).
- The **client** gains a **`PostingFeed`** seam. In "remote mode" (a feed URL+key in settings), `scan` pulls postings from the feed via PostgREST and skips `discover()`; postings flow into the existing `savePosting` + heuristic-score path. **Posting ids match** because the worker uses the same connectors/`makePostingId`, so saved scores and user actions stay attached across the source swap.

**Tech Stack:** TypeScript (strict, ESM), better-sqlite3 (local), **`postgres` (porsager) — new dep, worker-only**, zod, vitest, Biome. Supabase (Postgres + PostgREST). Client read side uses the existing `Fetcher` (no new client dep).

## Global Constraints

- **TypeScript-strict, ESM**, target ES2022, `moduleResolution: bundler`. `noUncheckedIndexedAccess`, `noImplicitOverride` on. No type assertions outside tests; never `!`.
- **Biome**: 2-space, 100-col, double quotes. `npm run lint:fix` before committing.
- **Tests colocated**, offline, dependency-injected with fixtures. Live Postgres/Supabase paths are **smoke-only** (excluded from CI), mirroring `smoke:airtable`/`smoke:scorer`. Do not put network in unit tests.
- **Coverage gate** stays green (statements 93 / branches 85 / functions 90 / lines 93).
- **Failures degrade, never crash.** Sources/feeds collect `Warning`s and return partial results.
- **Privacy invariant:** only **public** data (`postings`, `companies`, `scans`) is centralized. `profiles`, `match_results`, `user_actions`, `settings` never leave the device. Scoring runs on the client.
- **Commits:** Conventional Commits, no Claude co-author footer. Verify `npm run lint && npm run typecheck && npm test` before each commit. Branch: `feat/hosted-scan-backend`.

---

### Task 1: Extract a structural `ScanStore` and `runSourcing`

Separate sourcing from scoring so the same pipeline can target SQLite or Postgres, and so the worker can source without scoring.

**Files:**
- Modify: `src/cli/commands.ts` (extract `runSourcing`; `runScan` calls it then scores)
- Create: `src/discovery/scan-store.ts` (the `ScanStore` interface)
- Modify: `src/freshness/fetch-liveness.ts` (type its `repo` param as `ScanStore`, not `Repository`)
- Test: `src/cli/commands.test.ts` (extend), `src/discovery/scan-store.test.ts` (type-only / fake)

**Interfaces:**
- Produces `ScanStore` — the sourcing subset of `Repository`, structurally satisfied by it:
  ```ts
  export type ScanStore = {
    startScan(): number;
    recordDirectory(scanId: number, companies: CompanyRef[]): { newCompanies: string[]; removedCompanies: string[] };
    savePosting(posting: JobPosting, scanId: number): void;
    listLivePostingsNotSeen(scanId: number): JobPosting[];
    markPostingExpired(id: string): void;
    expireStalePostings(scanId: number): number;
    finishScan(scanId: number, summary: { postingsSeen: number; companiesSeen: number; newCompanies: string[]; removedCompanies: string[] }): void;
  };
  ```
- Produces `runSourcing(deps): Promise<SourcingOutcome>` — everything `runScan` does **except** the scoring loop. `SourcingOutcome = { postings: JobPosting[]; companies: CompanyLead[]; warnings: Warning[]; expired: number; newCompanies: string[]; removedCompanies: string[] }`.
- `runScan` becomes: `const sourced = await runSourcing(deps); // then heuristic-score sourced.postings` (the existing `pLimit(SCORE_CONCURRENCY)` loop), preserving today's behavior and output.

- [ ] **Step 1:** Write `scan-store.test.ts` proving `Repository` is assignable to `ScanStore` (a compile-time check via a typed assignment in a test, plus a tiny fake implementing it). Confirm `fetchLivenessSignal`/`recheckLiveness` accept the fake.
- [ ] **Step 2:** Add `ScanStore` to `src/discovery/scan-store.ts`; retype `recheckLiveness(repo: ScanStore, …)` in `fetch-liveness.ts`.
- [ ] **Step 3:** Extract `runSourcing` from `runScan`; have `runScan` call it then run the existing heuristic-score loop. Keep `ScanDeps` as-is for `runScan`; give `runSourcing` a `deps` whose `repo: ScanStore`.
- [ ] **Step 4:** Existing `commands.test.ts` scan tests must pass unchanged (behavior identical). Add one asserting `runSourcing` persists postings + records the directory but writes **no** `match_results`.
- [ ] **Step 5:** `npm run lint:fix && npm run typecheck && npm test`; commit `refactor(scan): extract sourcing-only runSourcing behind a ScanStore seam`.

---

### Task 2: Postgres schema + RLS (Supabase setup)

**Files:**
- Create: `src/backend/schema.sql` (the migration, also the source of truth checked into the repo)
- Create: `docs/backend/supabase-setup.md` (runbook)

**Interfaces:** none (infra). Mirror the public subset of `src/storage/schema.ts` in Postgres dialect.

- [ ] **Step 1:** Author `schema.sql`:
  ```sql
  create table if not exists companies (
    careers_url text primary key,
    name text,
    first_seen_scan bigint not null,
    last_seen_scan bigint not null,
    last_seen_at timestamptz not null default now()
  );
  create table if not exists scans (
    id bigserial primary key,
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    postings_seen integer,
    companies_seen integer,
    new_companies jsonb,
    removed_companies jsonb
  );
  create table if not exists postings (
    id text primary key,
    company text not null,
    title text not null,
    url text not null,
    source text not null,
    description text not null,
    location text,
    posted_at timestamptz,
    fetched_at timestamptz not null,
    last_seen_scan bigint,
    expired_at timestamptz
  );
  create index if not exists postings_live_idx on postings (expired_at, fetched_at desc);
  ```
- [ ] **Step 2:** RLS — anon role gets **read-only** access to the feed; only the service role writes:
  ```sql
  alter table postings enable row level security;
  alter table companies enable row level security;
  create policy "anon reads live postings" on postings for select to anon using (true);
  create policy "anon reads companies" on companies for select to anon using (true);
  -- no insert/update/delete policies for anon → writes require the service-role key (worker only).
  ```
- [ ] **Step 3:** Runbook (`docs/backend/supabase-setup.md`): create project, run `schema.sql`, capture `SUPABASE_URL`, `anon` key (client), `service_role` key (worker only — never shipped to clients). Note the PostgREST feed URL shape (Task 5).
- [ ] **Step 4:** Commit `feat(backend): add Postgres schema and Supabase RLS for the shared feed`.

---

### Task 3: `PostgresScanStore` (worker write side)

**Files:**
- Create: `src/backend/postgres-scan-store.ts`
- Create: `src/backend/postgres-mappers.ts` (pure row↔domain mappers)
- Test: `src/backend/postgres-mappers.test.ts` (pure, offline)
- Smoke: `scripts/smoke-postgres.ts` (live, opt-in, excluded from CI)

**Interfaces:**
- `class PostgresScanStore implements ScanStore` — constructed with a `postgres` Sql client; each method is the Postgres analogue of the SQLite one (upsert on conflict, scan bookkeeping, expiry).
- Pure mappers: `postingToRow(p: JobPosting): PostingRow` and `rowToPosting(r: PostingRow): JobPosting` — the **only** unit-tested logic here; SQL execution is smoke-tested.

- [ ] **Step 1:** Add `postgres` to dependencies (worker-only import; document that it isn't on the client hot path). 
- [ ] **Step 2:** Write `postgres-mappers.test.ts`: round-trip `rowToPosting(postingToRow(p))` preserves every field **including `id`** (the identity-parity guarantee); dates survive; optional `location`/`postedAt` handled.
- [ ] **Step 3:** Implement the pure mappers, then `PostgresScanStore` using parameterized `INSERT … ON CONFLICT … DO UPDATE` (postings keyed by `id`, companies by `careers_url`), `startScan`/`finishScan` against `scans`, `expireStalePostings`/`listLivePostingsNotSeen`/`markPostingExpired` mirroring the SQLite WHERE clauses.
- [ ] **Step 4:** `scripts/smoke-postgres.ts` (gated on `DATABASE_URL`): create store, run a tiny `startScan`→`savePosting`→`finishScan`, read it back, assert. Add `smoke:postgres` to package.json scripts (NOT to `test`).
- [ ] **Step 5:** `npm run lint:fix && npm run typecheck && npm test`; commit `feat(backend): add PostgresScanStore + pure row mappers (+ opt-in smoke)`.

---

### Task 4: Scanner worker entrypoint

**Files:**
- Create: `src/backend/scanner/main.ts`
- Create: `docs/backend/worker-runbook.md`
- Test: `src/backend/scanner/run-once.test.ts` (the pure orchestration, injected fakes)

**Interfaces:**
- `runScannerOnce(deps: { store: ScanStore; discoverDeps; onProgress?; log? }): Promise<SourcingOutcome>` — thin wrapper calling `runSourcing` (Task 1). No scoring, ever (the worker has no resume).
- `main.ts` — production wiring: build `PostgresScanStore` from `DATABASE_URL`/service-role, real `HttpFetcher` + `PlaywrightRenderer` + `PlaywrightSharedViewReader`, `settings` from env (lead-source keys via env, not a DB), run once, log the summary, exit non-zero on a hard failure. Designed to be invoked by a scheduler (cron), so "run once and exit" — not a long-lived loop.

- [ ] **Step 1:** Write `run-once.test.ts` with a fake `ScanStore` + injected fake `discover` proving it persists postings and returns the sourcing summary without scoring.
- [ ] **Step 2:** Implement `runScannerOnce` (delegates to `runSourcing`) and `main.ts` (the smoke-only production wiring; guard the entrypoint like `cli/main.ts` does).
- [ ] **Step 3:** Runbook: env vars (`DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, lead-source keys), and **two** deploy options — (a) Fly.io/Railway container on a cron schedule, (b) a scheduled GitHub Action running the worker. Note Playwright/Chromium needs the container image (or the Action's browser install), never a serverless function. Set a sane crawl cadence (e.g. every 6h, matching the local default).
- [ ] **Step 4:** `npm run lint:fix && npm run typecheck && npm test`; commit `feat(backend): add the scheduled scanner worker entrypoint`.

---

### Task 5: Client `PostingFeed` seam (read the remote feed)

**Files:**
- Create: `src/discovery/feed/posting-feed.ts` (interface + `HttpPostingFeed` + `FakePostingFeed`)
- Create: `src/discovery/feed/__fixtures__/feed-postings.json`
- Test: `src/discovery/feed/posting-feed.test.ts`

**Interfaces:**
- `interface PostingFeed { fetch(): Promise<{ postings: JobPosting[]; warnings: Warning[] }> }`.
- `class HttpPostingFeed implements PostingFeed` — GETs the PostgREST endpoint via the injected `Fetcher` with the anon key header, validates rows with a zod schema, maps via a feed mapper that **preserves `id`** (parity with the worker). Degrades to `{ postings: [], warnings }` on failure.
  - Endpoint shape: `${feedUrl}/rest/v1/postings?select=id,company,title,url,source,description,location,posted_at,fetched_at&expired_at=is.null&order=fetched_at.desc`, headers `{ apikey, Authorization: Bearer <anon> }`.
- `class FakePostingFeed` — canned postings/warnings for tests.

- [ ] **Step 1:** Fixture: a small PostgREST `postings` array (varied location/posted_at; one row reused to prove no id mutation).
- [ ] **Step 2:** Write `posting-feed.test.ts`: maps rows→`JobPosting` preserving id/fields; non-2xx and malformed payload each degrade to a warning; never throws.
- [ ] **Step 3:** Implement `HttpPostingFeed` (reuse `fetchFeed` where it fits) + `FakePostingFeed`.
- [ ] **Step 4:** `npm run lint:fix && npm run typecheck && npm test`; commit `feat(discovery): add a remote PostingFeed client (PostgREST)`.

---

### Task 6: Wire remote mode into `scan`

**Files:**
- Modify: `src/matching/settings-keys.ts` (`FEED_URL_SETTING = "feedUrl"`, `FEED_KEY_SETTING = "feedKey"`)
- Modify: `src/cli/commands.ts` (`runSourcing`: if a feed is configured, pull from it instead of `discover()`)
- Modify: `src/server/app.ts` (`feedUrl`/`feedKey` writable settings; `feedKey` write-only/masked)
- Test: `src/cli/commands.test.ts`, `src/server/app.test.ts` (extend)

**Interfaces:**
- `runSourcing` gains an optional `feed?: PostingFeed`. When present (remote mode): pull postings from `feed.fetch()`, run them through the existing `savePosting`/`recordDirectory`(derive companies from postings)/liveness/`finishScan`, and **skip `discover()`** entirely. When absent: today's crawl. Selection is by config (`feedUrl` set) in the production wiring; the param keeps it unit-testable.
- Settings surface: `feedUrl` (plain), `feedKey` (write-only, presence via `hasFeedKey`) — mirroring the Anthropic/Muse keys in `readSettings`/`WRITABLE_SETTINGS`.

- [ ] **Step 1:** Add the two settings keys.
- [ ] **Step 2:** Tests: `runSourcing` in remote mode persists feed postings and does **not** invoke the injected `discover`; absent feed still crawls (existing tests hold). `app.test.ts`: `feedUrl` round-trips, `feedKey` is masked + reported via `hasFeedKey` (update the exact-shape settings assertion).
- [ ] **Step 3:** Implement: in `runSourcing`, branch on `deps.feed`; in production wiring (`cli/main.ts` `runScanCommand` + `server/scan-runner.ts`), construct `HttpPostingFeed` when `feedUrl` is set in settings, else leave undefined. Add `feedUrl`/`feedKey` to `WRITABLE_SETTINGS` and `hasFeedKey` to `readSettings`.
- [ ] **Step 4:** `npm run lint:fix && npm run typecheck && npm test`; commit `feat(scan): pull postings from the remote feed when configured`.

---

### Task 7: Docs + close the loop

**Files:**
- Modify: `docs/sourcing-backend-exploration.md` (mark Phases 1–2 in-progress; link this plan)
- Modify: `README.md` (a short "Hosted feed (optional)" note: set `feedUrl`/`feedKey` to pull the shared feed instead of crawling; scoring stays local)

- [ ] **Step 1:** Update the exploration doc's phase table; add a "see the implementation plan" pointer.
- [ ] **Step 2:** README note on enabling remote mode + the privacy stance (only public posting data is centralized).
- [ ] **Step 3:** Commit `docs: document the hosted feed (remote mode) and update the backend roadmap`.

---

### Task 8: Final verification

- [ ] `npm run lint && npm run typecheck && npm run typecheck:web && npm run test:coverage && npm run build:web` — all green, coverage gate held.
- [ ] `grep -rn "runSourcing" src/cli/commands.ts src/backend/scanner/main.ts` — both the local scan and the worker go through it.
- [ ] Confirm the privacy invariant by inspection: nothing under `src/backend/` reads `profiles`/`match_results`/`user_actions`; the feed exposes only `postings`/`companies`.
- [ ] (Manual, opt-in) `npm run smoke:postgres` against a throwaway Supabase project; then point a local install at it via `feedUrl`/`feedKey` and confirm a scan pulls the feed (no crawl) and scores locally.

---

## Self-Review

**Spec coverage:**
- Shared store (Supabase Postgres + RLS) → Task 2.
- Sourcing-only central run, no scoring → Tasks 1, 3, 4 (`runSourcing` + `PostgresScanStore` + worker).
- Scheduled worker that can run Playwright (container/Action, not serverless) → Task 4 runbook.
- Read feed (PostgREST, anon read-only) → Tasks 2 (RLS) + 5 (client).
- Client consumes the feed; scoring stays local → Tasks 5, 6.
- Identity parity (ids match across local crawl / worker / feed) → Task 3 + Task 5 mapper tests assert `id` is preserved; worker uses the same `makePostingId`.
- Privacy invariant (only public data centralized) → Global Constraints + Task 8 inspection.
- Offline tests; live Postgres/Supabase is smoke-only → Tasks 3–6 + scripts.

**Out of scope (later phases):**
- Accounts / multi-user / server-side scoring (Phase 3).
- Crawling locally-tracked companies that aren't in the shared feed while in remote mode (note in Task 6 — v1 remote mode is feed-only; a hybrid "feed + local tracked crawl" is a follow-up).
- A bespoke Hono `/feed` API (PostgREST suffices for v1; revisit if we outgrow it).

**New dependency:** `postgres` (porsager) — worker-only; the client read path uses the existing `Fetcher`, so the local app gains no runtime dep.

**Type consistency:** `ScanStore` (Task 1) is satisfied by `Repository` (local) and `PostgresScanStore` (Task 3). `runSourcing` is consumed by both `runScan` (local, then scores) and `runScannerOnce` (worker, no scoring). `PostingFeed` (Task 5) is injected into `runSourcing` (Task 6). Settings keys (Task 6) match the `readSettings`/`WRITABLE_SETTINGS` pattern already used for the Anthropic and Muse keys.

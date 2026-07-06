# Postgres Versioned Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-applied, single-file `src/backend/schema.sql` with a proper **versioned migration** setup — ordered `supabase/migrations/*.sql` files as the single source of truth, applied to the hosted database automatically by CI on merge to `main`, with a runtime schema-version guard in the worker. This closes the class of failure that took down the scan-worker on 2026-07-05 (`column "kind" of relation "scans" does not exist`): schema drift caused by additive changes being applied to the live DB ad-hoc and lost on a rebuild.

**Background / why now:** The live database's migration history has exactly two tracked entries — `20260627222515 shared_sourcing_schema` (the June-27 baseline) and `20260706023908 sync_backend_schema_sql` (the emergency re-sync applied on 2026-07-06). Every column added between those dates (`scans.kind`, `postings.remote/country/company_id`, `companies.id`) was applied by hand and **never tracked**, so a database rebuild replayed only the baseline and silently dropped them. PR #98 added a worker-startup `ensureSchema()` self-heal as an interim guard; this plan supersedes it with a deliberate, CI-gated migration pipeline.

**Architecture:** `supabase/migrations/` becomes authoritative. CI (`migrate.yml`) runs `supabase db push` against the hosted DB on every merge to `main` that touches a migration, and runs `supabase db push --dry-run` on PRs as a check. `src/backend/schema.sql` is retired: its current contents become the reconciled baseline migration(s), and `smoke:postgres` + the worker stop depending on it. The worker replaces its DDL-applying `ensureSchema()` with a **read-only startup assertion** — it checks the DB's applied-migration version against an `EXPECTED_SCHEMA_VERSION` baked into the build and fails fast with an actionable message if the DB is behind, instead of either crashing cryptically mid-crawl (pre-#98) or silently mutating schema on every run (#98). Migrations are deliberate and CI-applied; the worker only reads.

**Tech Stack:** TypeScript-strict ESM, `postgres` (porsager) for the worker, Supabase CLI for migrations, GitHub Actions, vitest (colocated, offline). Node 24 (`.nvmrc`).

## Global Constraints

- **The live DB already has tracked history** (`20260627222515`, `20260706023908`). Local migration files MUST reconcile to those exact versions so `supabase db push` sees them as already-applied and is a no-op on prod — mismatched or renamed versions will make the CLI try to re-run or error. This is the riskiest step; verify with `supabase migration list` (local vs remote) before wiring CI.
- **Applied migrations are immutable.** Never edit a migration that has shipped to `main`; new changes are new files. A PR check enforces this (Task 7).
- **Additive-first, but ordered-capable.** Existing changes are all additive/idempotent; the point of this setup is to also support ordered/destructive changes (renames, backfills, `drop column`) that `schema.sql`'s "apply the whole idempotent file" model cannot express safely.
- **`db push` needs a session/direct connection.** The worker's `DATABASE_URL` may be the transaction-mode pooler (port 6543), which does not support the session features `db push` uses. Add a distinct secret `SUPABASE_DB_URL` (session pooler port 5432 / direct connection) with DDL privileges. Do not reuse `DATABASE_URL` blindly — confirm the port/mode first.
- **Migrations apply on merge, before the next worker run.** The worker runs from `main` on a daily cron (09:17 UTC); applying migrations on merge to `main` guarantees the schema is ready before code depending on it runs. CI ordering: migrate job must succeed before the change is considered deployed.
- No new runtime dependencies (Supabase CLI is a CI/dev tool, not bundled). Conventional Commits. NO Claude co-authored footer. Biome (2-space, 100-col, double quotes); `npm run lint` before commit.
- Coverage gate unchanged (statements 93 / branches 85 / functions 90 / lines 93). New worker code (`schema-version` check) is network-bound → covered by unit-testing the pure comparison and by `smoke:postgres`, excluded from the coverage gate like the rest of `src/backend/scanner`.

## File Structure

- `supabase/config.toml` — minimal Supabase project config (project ref `hhikmneqnygzighbksao`, migrations path). Committed; contains no secrets.
- `supabase/migrations/20260627222515_shared_sourcing_schema.sql` — reconciled baseline matching the first tracked remote version.
- `supabase/migrations/20260706023908_sync_backend_schema_sql.sql` — reconciled second version (the current full schema, = today's `schema.sql`). After these two, prod history == local history.
- `.github/workflows/migrate.yml` — apply-on-merge (`push` to `main`, `paths: supabase/migrations/**`) + PR dry-run + `workflow_dispatch` for manual re-apply/rebuild recovery.
- `src/backend/schema-version.ts` — `EXPECTED_SCHEMA_VERSION` constant + pure `isSchemaUpToDate(appliedVersions, expected)` helper.
- `src/backend/schema-version.test.ts` — unit tests for the pure comparison.
- `src/backend/scanner/main.ts` — replace `ensureSchema(sql)` with a read-only `assertSchemaVersion(sql)` that queries `supabase_migrations.schema_migrations` and fails fast if behind.
- `src/backend/ensure-schema.ts` + `ensure-schema.test.ts` — **removed** (superseded). Or retained behind a flag — see Task 4 decision note.
- `src/backend/schema.sql` — **removed**; content moves into the baseline migration.
- `scripts/smoke-postgres.ts` — stop assuming a hand-applied schema; document that it runs against a DB migrated via the CLI.
- `docs/backend/worker-runbook.md` — replace the "apply schema.sql by hand" instructions with the migration workflow (author, test, PR, auto-apply, rebuild recovery).
- `README.md` / `CLAUDE.md` — update the one-line schema description if it references `schema.sql`.

---

### Task 1: Scaffold `supabase/` and reconcile to remote history

- [ ] Install the Supabase CLI locally (dev only; not a repo dependency). Confirm `supabase --version`.
- [ ] `supabase init` (or hand-write `supabase/config.toml`) with `project_id = "hhikmneqnygzighbksao"` and the default `[db] migrations` path. Strip anything with secrets; commit only the static config.
- [ ] Reconcile local ↔ remote history. The remote already has `20260627222515` and `20260706023908`. Create local files with **exactly** those version prefixes:
  - `20260627222515_shared_sourcing_schema.sql` — the original June-27 schema (retrieve from git history of `schema.sql` at that date, or from the tracked migration if the CLI can pull it).
  - `20260706023908_sync_backend_schema_sql.sql` — the current full `schema.sql` verbatim (this is what was applied on 2026-07-06).
- [ ] Run `supabase migration list --db-url "$SUPABASE_DB_URL"` and confirm **both local and remote show the same two versions with no pending diff**. This proves the reconciliation is correct before any CI is wired.
- [ ] **Verification:** `supabase db push --db-url "$SUPABASE_DB_URL" --dry-run` reports "no changes" / nothing to apply against the live DB.

### Task 2: Retire `src/backend/schema.sql`

- [ ] Delete `src/backend/schema.sql` (its content now lives in the `20260706023908` baseline migration).
- [ ] Update `scripts/smoke-postgres.ts` header comment: the schema now comes from `supabase/migrations/` applied via the CLI, not a hand-applied file. No behavioral change to the smoke itself (it still assumes a migrated DB).
- [ ] Grep for any other `schema.sql` references (`README.md`, `CLAUDE.md`, docs) and repoint them at `supabase/migrations/`.
- [ ] **Verification:** `rg "schema\.sql"` returns only historical plan docs (not live code/docs); `npm run typecheck` + `npm run lint` clean.

### Task 3: Add the `migrate.yml` CI workflow

- [ ] New workflow with three triggers:
  - `pull_request` (paths `supabase/migrations/**`) → `supabase db push --db-url "$SUPABASE_DB_URL" --dry-run` as a **check** (surfaces what would apply; never mutates).
  - `push` to `main` (paths `supabase/migrations/**`) → `supabase db push --db-url "$SUPABASE_DB_URL"` (applies).
  - `workflow_dispatch` → manual apply, for rebuild-recovery ("re-run migrate to restore a reset DB").
- [ ] Use the official `supabase/setup-cli` action (pinned) to install the CLI; `timeout-minutes: 10`; `concurrency: { group: db-migrate, cancel-in-progress: false }` so two applies never overlap.
- [ ] Add repo Actions secret **`SUPABASE_DB_URL`** (session/direct connection with DDL rights). Document it alongside `DATABASE_URL` in the runbook. Confirm it is NOT the transaction-pooler (6543) connection.
- [ ] Fail loudly if the secret is missing (guard step with a clear message), mirroring how the worker guards `DATABASE_URL`.
- [ ] **Verification:** open a throwaway PR adding a trivial no-op migration (`select 1;` style or an `... if not exists` that's already present) → the dry-run check runs green and prints the plan; merging it applies cleanly and the run summary shows the applied version.

### Task 4: Replace the worker's DDL self-heal with a read-only version guard

> **Decision note.** PR #98's `ensureSchema()` makes every worker run apply DDL. With CI-applied migrations that becomes redundant and muddies "who owns schema." **Recommended:** remove it and add a fail-fast read-only check (below) — cleaner separation, and it still converts a cryptic mid-crawl `column does not exist` into an actionable startup error. **Alternative** (if you'd rather keep auto-heal): retain `ensureSchema` pointed at the baseline migration as a self-heal fallback and skip the assertion. Pick one; the recommendation assumes the former.

- [ ] Add `src/backend/schema-version.ts`: `export const EXPECTED_SCHEMA_VERSION = "20260706023908";` plus a pure `isSchemaUpToDate(applied: string[], expected: string): boolean` (max applied `>=` expected, string-comparable because versions are zero-padded timestamps).
- [ ] In `main.ts`, replace `await ensureSchema(sql)` with `await assertSchemaVersion(sql)`: query `select version from supabase_migrations.schema_migrations`, and if `!isSchemaUpToDate(...)`, log `"[scanner] DB schema is behind (have <max>, need <expected>) — run the migrate workflow"` and exit non-zero **before** crawling.
- [ ] Delete `src/backend/ensure-schema.ts` + `ensure-schema.test.ts` (or keep per the decision note).
- [ ] Bump `EXPECTED_SCHEMA_VERSION` in the same PR as any new migration — a one-line checklist item in the migration author guide (Task 6). Consider a tiny CI assertion that the constant equals the newest migration filename's version (Task 7).
- [ ] **Verification:** unit-test `isSchemaUpToDate` (behind / equal / ahead). Manually: point the worker at a DB missing the latest migration → it exits fast with the actionable message, does not crawl.

### Task 5: Author-a-migration developer workflow

- [ ] Confirm the loop: `supabase migration new <name>` → edit the generated `supabase/migrations/<ts>_<name>.sql` → test locally (`supabase db reset` on a local stack, or `db push --dry-run` against a throwaway project) → PR (dry-run check runs) → merge (auto-applies) → bump `EXPECTED_SCHEMA_VERSION`.
- [ ] For local testing without a hosted throwaway, document `supabase start` (local Postgres) + `supabase db reset` to replay all migrations from scratch — this also validates that the baseline bootstraps a **fresh** DB correctly (the case the old ad-hoc process kept breaking).
- [ ] **Verification:** `supabase db reset` on a fresh local stack replays all migrations and yields a schema identical to prod (`supabase db diff` reports no drift).

### Task 6: Docs — runbook + contributor guide

- [ ] Rewrite the `docs/backend/worker-runbook.md` "Environment" + schema sections: `SUPABASE_DB_URL` secret, "migrations are applied by CI on merge," and a **rebuild-recovery** subsection ("if the DB is reset, re-run the migrate workflow via `workflow_dispatch`").
- [ ] Add a short "Database migrations" section (contributor-facing): the author loop from Task 5, the immutability rule, and the `EXPECTED_SCHEMA_VERSION` bump.
- [ ] **Verification:** a reader following only the runbook can add a column and ship it end-to-end.

### Task 7: Guardrails (PR checks)

- [ ] CI check: **applied migrations are immutable** — on PRs, diff `supabase/migrations/` against `main` and fail if any file that already exists on `main` was modified/deleted (only new, higher-versioned files allowed).
- [ ] CI check: **`EXPECTED_SCHEMA_VERSION` matches the newest migration** — assert the constant equals the max version filename, so the worker guard can't silently lag the migrations.
- [ ] (Optional) lint migration filenames match `^\d{14}_[a-z0-9_]+\.sql$`.
- [ ] **Verification:** a PR that edits an old migration fails the immutability check; a PR that adds a migration without bumping the constant fails the version check.

### Task 8: Full verification

- [ ] `npm run lint`, `npm run typecheck`, `npm run test:coverage`, `npm run test:web` all green.
- [ ] `supabase migration list` shows local == remote, no pending.
- [ ] Dry-run PR check green; a real merged migration applies and the worker's next run passes the version guard and completes a full scan.
- [ ] Fresh-DB bootstrap validated via `supabase db reset` (Task 5) — proves a rebuild is now recoverable by replaying migrations, not by hand.

## Rollout / sequencing notes

1. Land Tasks 1–3 first (scaffold + reconcile + CI) **without** touching the worker — this is inert on the live DB (dry-run proves no changes) and gives a working pipeline.
2. Land Task 4 (worker guard) only after the pipeline is proven, so the worker's `EXPECTED_SCHEMA_VERSION` can never be ahead of what CI applies.
3. `ensure-schema.ts` (from #98) stays in place until Task 4 ships, so there is never a window with neither guard.

## Out of scope

- Per-user SQLite schema (`src/storage/schema.ts` + `Repository.migrate()`) — unchanged; it already self-heals additively and ships with the client, not deployed.
- Data backfills beyond what a migration needs inline — large backfills get their own plan.
- Multi-environment (staging vs prod) migration promotion — single project today; revisit if a staging project is added.

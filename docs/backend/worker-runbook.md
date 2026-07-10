# Scanner worker runbook

The scanner worker runs the shared **sourcing** crawl centrally and writes the deduplicated postings
to Postgres, which the local clients read as a feed (hybrid remote mode). It runs **once and exits**,
so a scheduler invokes it on an interval. It does **no scoring** (that stays on each client) and only
touches **public** data.

- Entry point: `src/backend/scanner/main.ts` (`npm run scan:worker`).
- Pipeline: `runScannerOnce` → `runSourcing` (the same code the local scan uses) → `PostgresScanStore`.

## Why it needs a container (not serverless)

The crawl drives **headless Chromium** (Playwright) for the Airtable directory read and the browser
fallback connector. That won't run in a serverless/Edge function (no Chromium, short time limits).
Run it where a real browser is available — a container or a CI runner with the browser installed.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Service-role Postgres connection (writes bypass RLS). From Supabase → Project Settings → Database. **Secret.** |
| `JOB_HUNTER_THE_MUSE_API_KEY` | no | Enables The Muse lead source; omit to skip it. |
| `JOB_HUNTER_SCAN_BUDGET_MS` | no | Wall-clock budget for the crawl (default 25 min). When reached, the crawl stops and the worker persists a partial feed instead of overrunning the job timeout. Keep it below the scheduler's timeout. |
| `PLAYWRIGHT_BROWSERS_PATH` | env-specific | Where Chromium is installed (set by the base image). |

The worker never needs the anon key or any per-user data.

## Database schema & migrations

The shared-feed schema lives in [`supabase/migrations/`](../../supabase/migrations) — versioned,
ordered SQL files that are the **single source of truth**. They are applied to the hosted database by
CI, not by hand and not by the worker:

- **On merge to `main`** (or a manual **Actions → migrate → Run workflow**), the
  [`migrate`](../../.github/workflows/migrate.yml) workflow runs `supabase db push`, which applies any
  migration versions not yet in the database's ledger. On a PR that touches `supabase/migrations/**`
  it runs `--dry-run` so review can preview the change. It needs the repo Actions secret
  **`SUPABASE_DB_URL`** — a *session*/direct Postgres connection with DDL rights (Supabase → Project
  Settings → Database → "Session pooler" or the direct connection on **port 5432**, *not* the
  transaction pooler on 6543). Until that secret is set the job no-ops green.
- **The worker only verifies.** On startup it checks the database's applied-migration version against
  `EXPECTED_SCHEMA_VERSION` (`src/backend/schema-version.ts`) and **exits fast with an actionable
  message if the database is behind** — it never mutates schema itself.

**Rebuild recovery:** if the database is ever reset/rebuilt, its migration ledger reverts and the
worker will refuse to run ("schema is behind"). Restore it by running the `migrate` workflow manually
(**Actions → migrate → Run workflow**); `db push` re-applies whatever versions are missing.

**Authoring a migration:** `supabase migration new <name>` → edit the generated
`supabase/migrations/<timestamp>_<name>.sql` → open a PR (the dry-run check previews it) → on merge it
applies automatically. Bump `EXPECTED_SCHEMA_VERSION` to the new version in the same PR (a test
enforces it equals the newest migration filename). **Never edit a migration already merged to `main`**
— applied migrations are immutable; ship a new file instead.

## Deploy options

### A. Scheduled GitHub Action (simplest) — shipped

This is the committed default: [`.github/workflows/scan-worker.yml`](../../.github/workflows/scan-worker.yml)
runs the worker on a cron (every 6h at :17) and on manual `workflow_dispatch`. It checks out the
repo, installs deps + Chromium, and runs `npm run scan:worker`, with a `concurrency` guard so two
crawls never overlap.

**To turn it on, add the repo Actions secrets** (Settings → Secrets and variables → Actions):

| Secret | Required | Value |
| --- | --- | --- |
| `DATABASE_URL` | yes | Service-role Postgres connection string (Supabase → Project Settings → Database). |
| `THE_MUSE_API_KEY` | no | The Muse API key, to enable that lead source. |

Until `DATABASE_URL` is set the scheduled run exits 1 with a clear message (it does nothing
destructive). Trigger a first run by hand from the Actions tab (`Run workflow`) once the secret is in
place; validate the store first with `npm run smoke:postgres` (see below). No always-on infra.

### B. Container on Fly.io / Railway with a cron

Build an image from a Playwright base (`mcr.microsoft.com/playwright:v1.x-jammy`), `npm ci`, and set
the schedule to run `npm run scan:worker` (Fly: a scheduled machine; Railway: a cron service). Same
env vars via the platform's secrets.

## Cadence & safety

- **Interval:** the committed workflow runs **once a day** (09:17 UTC); tune to how fresh the feed
  must be vs. load on the ATS boards. One central crawler is far gentler than N independent clients.
- **Run length:** a full crawl takes ~20-30 min and grows with the directory. The worker enforces a
  25-min crawl budget (`JOB_HUNTER_SCAN_BUDGET_MS`) so it always persists within the `timeout-minutes:
  45` cap instead of being hard-killed mid-crawl; if the budget is hit it writes a partial feed this
  run (a "Time budget reached" warning) and picks up the rest next run. Most of the tail is
  browser-fallback render timeouts on slow non-ATS careers pages — see "Warnings" below.
- **Idempotent:** each run upserts postings and reconciles liveness/expiry incrementally, so overlap
  or a missed run is harmless.
- **Validate first:** `npm run smoke:postgres` (with `DATABASE_URL`) confirms the store works against
  the database before scheduling the full crawl.
- **Run summary:** a final workflow step writes a one-line verdict (the `[scanner] done:` line) plus a
  collapsible warning list to the run's GitHub summary page, so you don't have to expand the raw logs.

## Warnings you can expect

The worker fails open on per-company errors — the scan still completes and writes everything it got.
Common, benign warnings:

- **`Render <url> timed out after 30000ms`** — a careers page with no known ATS and no JSON feed fell
  back to a headless render that didn't finish in 30s (heavy SPA, slow host). That company yields
  nothing this run; it's retried next run. The bulk of the tail is these.
- **`Skipped N companies on sites we don't scrape (LinkedIn/Indeed)`** — directory entries on
  anti-bot hosts on the `unscrapable` list; expected, review them manually.
- **`unexpected status NNN` / `Download is starting`** — a host returned an error or served a download
  instead of a page; skipped for this run.

## Idea: a private run-history admin view (not built)

Today run visibility is per-run: the GitHub summary page for the latest run, plus whatever's in the
raw logs. A lightweight future enhancement would be a **simple, owner-only admin page** that lists the
last several scans (e.g. ~5) — each with its timestamp, posting count, directory diff, expiries, and
warning count — so runs can be reviewed at a glance without opening GitHub. The data already exists:
each run writes a row to the `scans` table via `PostgresScanStore`, so this is mostly a read-only query
+ a small page, not new plumbing. It should load **separately from the main dashboard** (its own
route/build, gated to the operator) since it's an admin concern, not a user-facing feature, and must
stay read-only over public scan metadata. Captured here as a note, not a committed plan.

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
| `PLAYWRIGHT_BROWSERS_PATH` | env-specific | Where Chromium is installed (set by the base image). |

The worker never needs the anon key or any per-user data.

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
- **Run length:** a full crawl takes ~25 min (the `timeout-minutes: 30` cap leaves headroom). Most of
  the tail is browser-fallback render timeouts on slow non-ATS careers pages — see "Warnings" below.
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

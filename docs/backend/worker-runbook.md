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

### A. Scheduled GitHub Action (simplest)

A workflow on a cron that checks out the repo, installs deps + Chromium, and runs the worker:

```yaml
# .github/workflows/scan-worker.yml
name: scan-worker
on:
  schedule: [{ cron: "17 */6 * * *" }]   # every 6h, off-:00
  workflow_dispatch: {}
jobs:
  scan:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: ".nvmrc" }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run scan:worker
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          JOB_HUNTER_THE_MUSE_API_KEY: ${{ secrets.THE_MUSE_API_KEY }}
```

Put `DATABASE_URL` (and optionally the Muse key) in the repo's Actions secrets. No always-on infra.

### B. Container on Fly.io / Railway with a cron

Build an image from a Playwright base (`mcr.microsoft.com/playwright:v1.x-jammy`), `npm ci`, and set
the schedule to run `npm run scan:worker` (Fly: a scheduled machine; Railway: a cron service). Same
env vars via the platform's secrets.

## Cadence & safety

- **Interval:** ~6h matches the local default refresh; tune to how fresh the feed must be vs. load on
  the ATS boards. One central crawler is far gentler than N independent clients.
- **Idempotent:** each run upserts postings and reconciles liveness/expiry incrementally, so overlap
  or a missed run is harmless.
- **Validate first:** `npm run smoke:postgres` (with `DATABASE_URL`) confirms the store works against
  the database before scheduling the full crawl.

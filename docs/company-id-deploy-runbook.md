# companyId — Worker/Feed Deploy Runbook

This is a coordinated deploy of the hosted worker plus the shared-feed schema. The local half
(SQLite `companyId` + local retry scoping) works as soon as the PR merges.

> **Note (superseded):** the schema is now applied via versioned migrations in
> [`supabase/migrations/`](../supabase/migrations) by the `migrate` CI workflow, not the manual
> `psql -f schema.sql` step described below. The companyId columns are part of migration
> `20260706023908`; on a current database they are already applied. This runbook is kept as a record
> of the original rollout — see [`docs/backend/worker-runbook.md`](./backend/worker-runbook.md) for the
> migration workflow. The feed-scoping payoff — retry scoping across the shared feed, not just the local crawl —
only activates once the hosted worker starts emitting `company_id` on `postings` rows in Supabase.

**Ordering note (read first):** shipping the local client before the worker has run is SAFE.
`FeedRow.company_id` is `.nullish()` in the zod schema, so retry feed-scoping simply no-ops on rows
that don't have it yet — it degrades to local-crawl-only scoping, not a crash. **Never make
`FeedRow.company_id` required.** Doing so would fail zod validation on every row written by an
old (not-yet-redeployed) worker and silently zero out the entire feed for every user until the
worker catches up.

## Steps, in order

### 1. Apply the additive schema to Supabase

Apply the migrations (normally via the `migrate` CI workflow — **Actions → migrate → Run workflow** —
or locally with `supabase db push --db-url "<session-connection-string>"`). The relevant change is
migration `20260706023908`, which is additive and idempotent (`add column if not exists`), so it's
safe to re-run. It adds:

- `companies.id` plus its (non-unique) index
- `postings.company_id` plus its index

`companies.id` is intentionally **non-unique** — it is a content-hash of the normalized careers URL,
so distinct `careers_url` rows (case / trailing-slash / query-string near-duplicates) can share an
id. The migration drops any pre-existing `companies_id_idx` before recreating it non-unique, because
`create index if not exists` matches by name only and would otherwise leave a stale unique index in
place. (An early companyId build shipped this index as `unique`; that was corrected — a DB that
already has the unique index self-heals when the migration re-applies.)

### 2. Backfill — not required

No manual backfill step is required. `companies.id` self-heals via `recordDirectory`'s upsert
(`id = excluded.id` in the `ON CONFLICT` clause) on the very next worker scan, and
`postings.company_id` is stamped on new and re-crawled postings going forward. Legacy posting rows
that predate this change stay `NULL` — feed-scoping treats `NULL` as "unknown, not excluded," so
this is safe.

If you want `companies.id` populated immediately rather than waiting for the next scheduled scan,
that would require a one-off Node script using the app's `makeCompanyId`. No such script is shipped
with this change — treat it as an optional follow-up only if there's a concrete need to populate ids
ahead of the next scan.

### 3. Deploy and run the worker

Deploy the updated worker code, then run it at least once (ideally twice, to confirm the second
run re-stamps `company_id` on postings the first run already touched):

```bash
npm run scan:worker
```

This is `node --import tsx src/backend/scanner/main.ts`. After it completes, feed `postings` rows
start carrying `company_id`.

### 4. Local client

The local client changes ship in the same PR as this backend work — there's nothing to deploy
separately. Retry feed-scoping activates automatically the first time a client fetches feed rows
that carry `company_id`. Until the worker has run, the client keeps working exactly as before
(local-crawl-only scoping); there's no error state to watch for.

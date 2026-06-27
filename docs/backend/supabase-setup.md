# Supabase setup — shared sourcing backend

Runbook for standing up the hosted store behind the shared posting feed (Phase 1 of
`docs/superpowers/plans/2026-06-27-hosted-scan-backend.md`). The store holds only **public** data
(postings/companies/scans); resumes, scores, and user actions never leave the device.

Two roles use the database, with very different trust:

| Role | Key | Who | Access |
| --- | --- | --- | --- |
| **service role** | `service_role` (secret) | the scanner **worker** only | full read/write (bypasses RLS) |
| **anon** | `anon` (publishable) | the local **client** (read feed) | `SELECT` on `postings`/`companies` only |

## 1. Create the project

1. Create a new project at <https://supabase.com/dashboard> (any region near your users).
2. Note these from **Project Settings → API**:
   - **Project URL** → `SUPABASE_URL` (e.g. `https://abcd1234.supabase.co`)
   - **anon / publishable key** → the client's feed key (read-only; safe to ship)
   - **service_role key** → the worker's key. **Secret — never ship it to clients or commit it.**
3. Note the direct Postgres connection string from **Project Settings → Database** → `DATABASE_URL`
   (the worker uses this; the client never does).

## 2. Apply the schema

Run `src/backend/schema.sql` once — it creates the tables, indexes, and RLS policies, and is
idempotent (safe to re-run after edits):

- **SQL editor:** paste the file's contents and run, **or**
- **psql:** `psql "$DATABASE_URL" -f src/backend/schema.sql`

The script enables RLS so the anon key can only read `postings`/`companies`; every write requires the
service-role key, which only the worker holds.

## 3. The feed endpoint (what the client reads)

PostgREST auto-exposes the tables. The client fetches live postings, newest first, with the anon key:

```
GET ${SUPABASE_URL}/rest/v1/postings
      ?select=id,company,title,url,source,description,location,posted_at,fetched_at
      &expired_at=is.null
      &order=fetched_at.desc
Headers:
  apikey: <anon key>
  Authorization: Bearer <anon key>
```

This is exactly what the `HttpPostingFeed` client (a later task) issues; no bespoke API is needed for
v1. Quick check once the worker has run:

```sh
curl -s "$SUPABASE_URL/rest/v1/postings?select=id,company,title&limit=3" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY"
```

## 4. Environment variables

| Variable | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | worker | direct Postgres connection (service role) |
| `SUPABASE_URL` | client | project URL for the PostgREST feed |
| `SUPABASE_ANON_KEY` | client | read-only feed key (safe to distribute) |
| `SUPABASE_SERVICE_ROLE_KEY` | worker | **secret**; never shipped to clients |

The worker's deploy and schedule (Fly.io/Railway cron or a scheduled GitHub Action) are covered in
the worker runbook (a later task). Keep the service-role key in the worker's secret store only.

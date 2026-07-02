-- Shared sourcing backend — Postgres schema (Supabase).
--
-- Mirrors the PUBLIC subset of the local SQLite schema (src/storage/schema.ts): postings, companies,
-- and scans. The per-user tables (profiles, match_results, user_actions, settings) are intentionally
-- absent — they never leave the device. The hosted scanner worker writes these tables (service-role
-- key); the local client reads them through PostgREST with the anon key (see RLS below).
--
-- Apply with the Supabase SQL editor or `psql "$DATABASE_URL" -f src/backend/schema.sql`.
-- Idempotent: safe to re-run.

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
  remote boolean,
  country text,
  posted_at timestamptz,
  fetched_at timestamptz not null,
  -- Incremental-scan bookkeeping: the scan that last saw this posting, and when it was judged gone.
  last_seen_scan bigint,
  expired_at timestamptz
);

-- Drives the feed query (live postings, newest first) and the "not seen this scan" liveness sweep.
create index if not exists postings_live_idx on postings (expired_at, fetched_at desc);
create index if not exists postings_last_seen_idx on postings (last_seen_scan);

-- Row Level Security: the feed is public read-only; all writes require the service role (worker).
-- The anon role (used by the local client via PostgREST) can SELECT postings/companies and nothing
-- else. With RLS enabled and no insert/update/delete policy, anon writes are rejected; the
-- service-role key bypasses RLS, so only the worker can populate the tables. `scans` is internal
-- bookkeeping with no anon policy, so it isn't exposed to the feed at all.
alter table postings enable row level security;
alter table companies enable row level security;
alter table scans enable row level security;

drop policy if exists "anon reads live postings" on postings;
create policy "anon reads live postings" on postings for select to anon using (true);

drop policy if exists "anon reads companies" on companies;
create policy "anon reads companies" on companies for select to anon using (true);

-- Idempotent column additions for databases that predate these columns.
alter table postings add column if not exists remote boolean;
alter table postings add column if not exists country text;

alter table companies add column if not exists id text;
-- companies.id is NOT unique: distinct careers_url rows can normalize to the same companyId
-- (case/trailing-slash/query-string near-duplicates), so id is intentionally many-to-one with
-- careers_url. An earlier release created this index as UNIQUE; drop it unconditionally before
-- recreating non-unique, because `create index if not exists` matches by NAME only (not by
-- definition) and would leave a pre-existing unique index in place. Mirrors the SQLite migrate()
-- self-heal. `drop index if exists` is a no-op on a fresh DB.
drop index if exists companies_id_idx;
create index if not exists companies_id_idx on companies (id);
alter table postings add column if not exists company_id text;
create index if not exists postings_company_id_idx on postings (company_id);

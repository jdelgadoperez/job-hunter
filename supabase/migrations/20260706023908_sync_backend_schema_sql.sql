-- Sync the backend schema forward to the columns and indexes added after the 20260627222515
-- baseline: the incremental-scan (`scans.kind`), location (`postings.remote`/`country`), and
-- companyId (`companies.id`, `postings.company_id`) work. Reconciled to the migration recorded
-- remotely as version 20260706023908 (applied 2026-07-06 to re-sync a database that had drifted).
--
-- Every statement is idempotent (`add column if not exists` / `create index if not exists`) so
-- replaying on a fresh database (after the baseline) or on an already-current one is safe.

alter table postings add column if not exists remote boolean;
alter table postings add column if not exists country text;

alter table companies add column if not exists id text;
-- companies.id is NOT unique: distinct careers_url rows can normalize to the same companyId
-- (case/trailing-slash/query-string near-duplicates), so id is intentionally many-to-one with
-- careers_url. An earlier release created this index as UNIQUE; drop it unconditionally before
-- recreating non-unique, because `create index if not exists` matches by NAME only (not by
-- definition) and would leave a pre-existing unique index in place. Mirrors the SQLite migrate()
-- self-heal. `drop index if exists` is a no-op on a fresh database.
drop index if exists companies_id_idx;
create index if not exists companies_id_idx on companies (id);
alter table postings add column if not exists company_id text;
create index if not exists postings_company_id_idx on postings (company_id);

-- listFreshCompanyUrls range-scans last_seen_at on every incremental scan.
create index if not exists companies_last_seen_at_idx on companies (last_seen_at);

alter table scans add column if not exists kind text not null default 'full';
-- Staleness clock (expireStalePostings) counts only full scans; index the predicate.
create index if not exists scans_kind_idx on scans (kind, id);

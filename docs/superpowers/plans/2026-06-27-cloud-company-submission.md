# Cloud Company Submission — Implementation Plan (option B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user contribute their tracked companies to the **shared cloud crawl**, so the central scanner worker discovers them for everyone — instead of (or in addition to) each client crawling its own tracked companies locally. This is the "submit companies to the cloud for scanning" feature, building on the hosted scan backend (`docs/superpowers/plans/2026-06-27-hosted-scan-backend.md`).

**Relationship to option A:** Option A (shipping in Tasks 5–6 of the backend plan) keeps tracked companies **local** and crawls them on the client so remote mode never silently drops them. B is the better end-state: once submitted companies are crawled centrally, the client can stop locally crawling them. **A stays as the fallback** when no cloud submission is configured; B supersedes the local-crawl path for submitted companies when it is.

**The core constraint:** v1 has **no user accounts**, and the anon key ships in the client (so it's effectively public). A raw anon `INSERT` policy on a submissions table would let anyone on the internet write arbitrary URLs into the shared crawl — a spam and SSRF vector. So the write path is a **guarded Supabase Edge Function** (service-role insert behind validation + rate limiting), never a direct anon insert.

**Tech stack:** TypeScript (strict, ESM) for the client; a Deno **Supabase Edge Function** for the endpoint; Postgres (the existing project `hhikmneqnygzighbksao`). zod, vitest, Biome. The worker reads submissions through the existing `LeadSource` seam.

## Global Constraints

- TypeScript-strict, ESM. No `any` / non-null `!` outside tests. Biome-clean (2-space, 100-col, double quotes).
- Tests colocated, offline, dependency-injected; live Supabase/Edge paths are smoke-only (excluded from CI), like `smoke:postgres`.
- Failures degrade, never crash. Submission failures surface as warnings; they never block a scan.
- **Privacy:** a submitted company's postings become visible in the shared feed to all users, but the **submitter is never identified** (no user id stored). Document this in the UI copy and README.
- **Security:** every submitted URL passes the existing SSRF guard (`src/net/ssrf-guard.ts`) and `unscrapable` check before the worker ever fetches it; the Edge Function validates and rate-limits before insert.
- Commits: Conventional Commits, no Claude footer. Verify `npm run lint && npm run typecheck && npm test` before committing. Branch: `feat/cloud-company-submission`.

---

### Task 1: `submitted_companies` table + RLS

**Files:** `src/backend/schema.sql` (extend), apply via `apply_migration` to the live project.

**Schema:**
```sql
create table if not exists submitted_companies (
  careers_url text primary key,
  name text,
  status text not null default 'approved',   -- 'approved' | 'pending' | 'rejected' (kill-switch / moderation)
  submitted_at timestamptz not null default now(),
  last_crawled_scan bigint
);
alter table submitted_companies enable row level security;
-- No anon policy: the client never reads or writes this table directly. The Edge Function
-- (service role) inserts; the worker (service role) reads. Anon is fully locked out.
```

- [ ] Add the table + RLS to `schema.sql`; `apply_migration` to `hhikmneqnygzighbksao`; verify with `list_tables` + `get_advisors` (expect an INFO "RLS enabled, no policy" — intentional, like `scans`).
- [ ] Commit `feat(backend): add submitted_companies table (service-role only)`.

---

### Task 2: `submit-company` Edge Function (the guarded write path)

**Files:** `supabase/functions/submit-company/index.ts` (Deno), deployed via `deploy_edge_function`.

**Contract:** `POST { careersUrl: string, name?: string }` → `201 { ok: true }` | `400` (invalid URL) | `409` (already known) | `429` (rate-limited). Validation, in order:
1. Parse body; `careersUrl` must be a valid `http(s)` URL.
2. **SSRF / scope guard:** reject private/loopback/link-local hosts and `unscrapable` hosts (LinkedIn/Indeed/…). Mirror `assertAllowedUrl` + `isUnscrapableHost` logic (port the checks into the function, or call a shared validator).
3. **Rate limit:** per-IP cap (e.g. N/hour) using a small `submission_throttle` table or Supabase's built-in; plus a global daily cap.
4. **Dedup:** skip if the URL already exists in `companies`, `submitted_companies`, or the directory snapshot (normalized URL).
5. Insert with the **service-role** client (bypasses RLS), `status = 'approved'`.

- [ ] Implement the function with the validation pipeline above; unit-test the pure validator (URL/SSRF/unscrapable/dedup-decision) offline.
- [ ] `deploy_edge_function` to the project; smoke-test by POSTing a valid + an invalid + a private-host URL and asserting 201/400/400.
- [ ] Commit `feat(backend): add guarded submit-company edge function`.

**Open decision (flag to maintainer):** auto-approve with guards (recommended — postings are public data anyway, and the SSRF/dedup/rate-limit guards bound abuse) vs. a `pending` moderation queue requiring manual approval. Default: auto-approve + a denylist + a kill-switch (`status='rejected'`).

---

### Task 3: Worker reads submissions as a lead source

**Files:** `src/backend/submitted-companies-source.ts` (+ test); wire into the worker's lead collection (Task 4 of the backend plan).

**Interfaces:** a `SubmittedCompaniesSource implements LeadSource` (the existing seam) that, given the Postgres `sql`, selects `careers_url`/`name` from `submitted_companies WHERE status = 'approved'` and returns `CompanyLead[]`. The worker runs it alongside the Airtable directory / aggregator sources, so submitted companies flow through the **same** `resolve-ats` → connectors path and land in the shared `postings` feed.

- [ ] TDD the source against a fake `sql` (pure mapping of rows → `CompanyLead`); the live query is smoke-covered.
- [ ] After a worker run, stamp `last_crawled_scan` so stale submissions can be pruned later.
- [ ] Commit `feat(backend): crawl submitted companies as a worker lead source`.

---

### Task 4: Client submission + `track add` wiring

**Files:** `src/discovery/feed/cloud-submission.ts` (`CloudSubmission` client) + test; wire `track add` / the dashboard "Companies" add action; settings.

**Interfaces:**
- `interface CloudSubmission { submit(careersUrl: string, name?: string): Promise<{ ok: boolean; warning?: string }> }`; `HttpCloudSubmission` POSTs to the Edge Function URL with the anon key; degrades to a warning, never throws. `FakeCloudSubmission` for tests.
- A `submitUrl` (or derive from `feedUrl`) setting; reuse the anon key.
- When remote mode + submission are configured, `track add` (CLI `src/cli/commands.ts` `trackAdd` and `POST /api/companies`) **also** submits to the cloud. The local `tracked_companies` row is still written (so option A's local crawl remains a fallback until B is proven), but the company now also enters the central crawl.

- [ ] TDD the client (success / 409 / 429 / network-fail → warning) with a fake fetcher.
- [ ] Wire the two `track add` call sites to fire-and-warn the submission; surface the warning in CLI output / the dashboard.
- [ ] Commit `feat(discovery): submit tracked companies to the cloud crawl`.

---

### Task 5: Retire the local crawl for submitted companies (optional, gated)

Once B is validated, remote mode can skip the **local** crawl of tracked companies that were successfully submitted (they'll come back via the feed), keeping only un-submittable ones (private hosts) local. Gate behind a setting so users can keep local crawling if they prefer privacy (not contributing their targets to the shared pool).

- [ ] Add the toggle; default to "submit + rely on feed" only after B has run in production for a while.

---

### Task 6: Docs

- [ ] README + dashboard copy: what "submit to cloud" does, that submissions are public-but-anonymous, and how to opt out (keep companies local).
- [ ] Update `docs/sourcing-backend-exploration.md` and the backend plan to note B supersedes A's local crawl for submitted companies.

---

## Self-Review

- **Abuse surface is the crux** and it's addressed at the only writable point (the Edge Function): SSRF + unscrapable + rate-limit + dedup + kill-switch, with no anon table write. Tasks 1–2.
- **Reuses existing seams:** submissions are just another `LeadSource` for the worker (Task 3) and another small HTTP client for the app (Task 4) — no new architecture.
- **Privacy is explicit:** anonymous submissions, public postings, an opt-out. Global constraints + Task 6.
- **Safe rollout:** A's local crawl stays as the fallback; the local crawl is only retired behind a gated toggle once B is proven (Task 5).
- **Open decisions for the maintainer:** auto-approve vs. moderation queue (Task 2); whether to require any lightweight token given the public anon key; the rate-limit numbers.

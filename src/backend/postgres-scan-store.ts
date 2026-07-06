import { makeCompanyId } from "@app/discovery/company-id";
import type { DirectoryDiff, ScanScope, ScanStore } from "@app/discovery/scan-store";
import type { JobPosting } from "@app/domain/types";
import type { CompanyRef } from "@app/storage/repository";
import type { Sql } from "postgres";
import { type PostingRow, postingToRow, rowToPosting } from "./postgres-mappers";

/**
 * Rows per multi-row INSERT. Postgres caps a statement at 65,535 bind parameters; the widest insert
 * here is postings (10 columns), so 1,000 rows = 10k params — a comfortable margin that still cuts
 * a ~12k-posting crawl from ~12k round-trips to ~12.
 */
const INSERT_CHUNK_SIZE = 1000;

/** Split an array into consecutive chunks of at most `size` (the last may be smaller). */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * The hosted scanner worker's `ScanStore`, backed by Postgres (Supabase) via `postgres` (porsager).
 * Mirrors the local SQLite `Repository`'s sourcing methods one-for-one — same upsert/revival/expiry
 * semantics — so the shared `runSourcing` pipeline behaves identically whether it writes locally or
 * to the central store. Writes require the service-role connection (RLS is bypassed by it); the
 * client never uses this class (it reads the public feed via PostgREST).
 *
 * Staleness (`expireStalePostings`) is `kind`-aware, matching SQLite: only `kind = 'full'` scans
 * advance the expiry clock, so scoped `"retry"`/`"incremental"` scans never push an untouched
 * posting toward expiry.
 *
 * `bigint` columns (`scans.id`, `last_seen_scan`) come back as strings from the driver, so they are
 * coerced with `Number`. SQL execution is validated by the opt-in `smoke:postgres` script, not unit
 * tests; the pure row mapping is unit-tested in `postgres-mappers.test.ts`.
 */
export class PostgresScanStore implements ScanStore {
  constructor(private readonly sql: Sql) {}

  async startScan(kind: ScanScope = "full"): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      INSERT INTO scans (started_at, kind) VALUES (now(), ${kind}) RETURNING id`;
    return Number(rows[0]?.id);
  }

  async recordDirectory(
    scanId: number,
    companies: CompanyRef[],
    options: { computeRemoved?: boolean } = {},
  ): Promise<DirectoryDiff> {
    const computeRemoved = options.computeRemoved ?? true;
    const existing = await this.sql<
      { careers_url: string; name: string | null; last_seen_scan: string }[]
    >`SELECT careers_url, name, last_seen_scan FROM companies`;
    const existingUrls = new Set(existing.map((e) => e.careers_url));
    const currentUrls = new Set(companies.map((c) => c.careersUrl));
    // The previous scan id, so "removed" means dropped *this* scan only (a company gone several
    // scans ago has an older last_seen_scan and isn't re-reported).
    const prev = await this.sql<{ id: string | null }[]>`
      SELECT MAX(id) AS id FROM scans WHERE id < ${scanId}`;
    const prevScan = prev[0]?.id == null ? null : Number(prev[0].id);
    const isBaseline = existing.length === 0;

    const newCompanies =
      !computeRemoved || isBaseline ? [] : companies.filter((c) => !existingUrls.has(c.careersUrl));
    const removedCompanies =
      !computeRemoved || isBaseline || prevScan === null
        ? []
        : existing
            .filter((e) => Number(e.last_seen_scan) === prevScan && !currentUrls.has(e.careers_url))
            .map((e) => ({ careersUrl: e.careers_url, ...(e.name ? { name: e.name } : {}) }));

    // Bulk-upsert all companies in chunked multi-row INSERTs (one round-trip per chunk) rather than
    // one round-trip per company — the directory is ~1k+ leads, so the serial form dominated runtime.
    // `last_seen_at` is omitted from the column list so new rows take the column's `default now()`;
    // the conflict branch refreshes it explicitly.
    const companyRows = companies.map((c) => ({
      id: makeCompanyId(c.careersUrl),
      careers_url: c.careersUrl,
      name: c.name ?? null,
      first_seen_scan: scanId,
      last_seen_scan: scanId,
    }));
    const companyColumns = [
      "id",
      "careers_url",
      "name",
      "first_seen_scan",
      "last_seen_scan",
    ] as const;
    for (const batch of chunk(companyRows, INSERT_CHUNK_SIZE)) {
      await this.sql`
        INSERT INTO companies ${this.sql(batch, ...companyColumns)}
        ON CONFLICT (careers_url) DO UPDATE SET
          id = excluded.id,
          name = excluded.name,
          last_seen_scan = excluded.last_seen_scan,
          last_seen_at = now()`;
    }

    return { newCompanies, removedCompanies };
  }

  async savePosting(posting: JobPosting, scanId: number | null = null): Promise<void> {
    const r = postingToRow(posting);
    await this.sql`
      INSERT INTO postings
        (id, company, title, url, source, description, location, remote, country, company_id,
         posted_at, fetched_at, last_seen_scan, expired_at)
      VALUES (${r.id}, ${r.company}, ${r.title}, ${r.url}, ${r.source}, ${r.description},
         ${r.location}, ${r.remote}, ${r.country}, ${r.company_id},
         ${r.posted_at}, ${r.fetched_at}, ${scanId}, NULL)
      ON CONFLICT (id) DO UPDATE SET
        company = excluded.company,
        title = excluded.title,
        url = excluded.url,
        source = excluded.source,
        description = excluded.description,
        location = excluded.location,
        remote = excluded.remote,
        country = excluded.country,
        company_id = excluded.company_id,
        posted_at = excluded.posted_at,
        fetched_at = excluded.fetched_at,
        last_seen_scan = COALESCE(excluded.last_seen_scan, postings.last_seen_scan),
        -- Revive a reappeared posting only when this save belongs to a scan.
        expired_at = CASE WHEN excluded.last_seen_scan IS NULL THEN postings.expired_at ELSE NULL END`;
  }

  /**
   * Bulk version of `savePosting`: upsert many postings in chunked multi-row INSERTs (one round-trip
   * per chunk) rather than one per posting. A crawl writes ~12k postings, so the serial form was the
   * dominant cost of the post-crawl write phase (and pushed the worker past its CI timeout). Same
   * upsert/revival semantics as `savePosting`; chunked to stay well under Postgres's bind-parameter
   * cap. `scanId` is the scan these saves belong to (always set on the worker path).
   */
  async savePostings(postings: JobPosting[], scanId: number | null = null): Promise<void> {
    if (postings.length === 0) return;
    const rows = postings.map((p) => ({ ...postingToRow(p), last_seen_scan: scanId }));
    const columns = [
      "id",
      "company",
      "title",
      "url",
      "source",
      "description",
      "location",
      "remote",
      "country",
      "company_id",
      "posted_at",
      "fetched_at",
      "last_seen_scan",
    ] as const;
    for (const batch of chunk(rows, INSERT_CHUNK_SIZE)) {
      await this.sql`
        INSERT INTO postings ${this.sql(batch, ...columns)}
        ON CONFLICT (id) DO UPDATE SET
          company = excluded.company,
          title = excluded.title,
          url = excluded.url,
          source = excluded.source,
          description = excluded.description,
          location = excluded.location,
          remote = excluded.remote,
          country = excluded.country,
          company_id = excluded.company_id,
          posted_at = excluded.posted_at,
          fetched_at = excluded.fetched_at,
          last_seen_scan = COALESCE(excluded.last_seen_scan, postings.last_seen_scan),
          -- Revive a reappeared posting only when this save belongs to a scan.
          expired_at = CASE WHEN excluded.last_seen_scan IS NULL THEN postings.expired_at ELSE NULL END`;
    }
  }

  async listLivePostingsNotSeen(scanId: number): Promise<JobPosting[]> {
    const rows = await this.sql<PostingRow[]>`
      SELECT id, company, title, url, source, description, location, remote, country, company_id, posted_at, fetched_at
      FROM postings
      WHERE expired_at IS NULL AND (last_seen_scan IS NULL OR last_seen_scan != ${scanId})`;
    return rows.map(rowToPosting);
  }

  async listFreshCompanyUrls(freshnessHours: number): Promise<string[]> {
    if (freshnessHours <= 0) return [];
    const rows = await this.sql<{ careers_url: string }[]>`
      SELECT careers_url FROM companies
      WHERE last_seen_at IS NOT NULL
        AND last_seen_at >= now() - make_interval(hours => ${freshnessHours})`;
    return rows.map((r) => r.careers_url);
  }

  async markPostingExpired(postingId: string): Promise<boolean> {
    const rows = await this.sql`
      UPDATE postings SET expired_at = now()
      WHERE id = ${postingId} AND expired_at IS NULL
      RETURNING id`;
    return rows.length > 0;
  }

  async expireStalePostings(scanId: number, staleAfter = 2): Promise<number> {
    // Only *finished* scans count toward the staleness clock — a crashed/killed scan (finished_at
    // IS NULL) must not push untouched postings toward expiry. Matches the SQLite Repository.
    const rows = await this.sql`
      UPDATE postings SET expired_at = now()
      WHERE expired_at IS NULL AND last_seen_scan IS NOT NULL
        AND (
          SELECT COUNT(*) FROM scans
          WHERE kind = 'full' AND finished_at IS NOT NULL
            AND id > postings.last_seen_scan AND id <= ${scanId}
        ) >= ${staleAfter}
      RETURNING id`;
    return rows.length;
  }

  async finishScan(
    scanId: number,
    summary: { postingsSeen: number; companiesSeen: number } & DirectoryDiff,
  ): Promise<void> {
    await this.sql`
      UPDATE scans SET
        finished_at = now(),
        postings_seen = ${summary.postingsSeen},
        companies_seen = ${summary.companiesSeen},
        new_companies = ${this.sql.json(summary.newCompanies)},
        removed_companies = ${this.sql.json(summary.removedCompanies)}
      WHERE id = ${scanId}`;
  }
}

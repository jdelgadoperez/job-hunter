import type { DirectoryDiff, ScanStore } from "@app/discovery/scan-store";
import type { JobPosting } from "@app/domain/types";
import type { CompanyRef } from "@app/storage/repository";
import type { Sql } from "postgres";
import { type PostingRow, postingToRow, rowToPosting } from "./postgres-mappers";

/**
 * The hosted scanner worker's `ScanStore`, backed by Postgres (Supabase) via `postgres` (porsager).
 * Mirrors the local SQLite `Repository`'s sourcing methods one-for-one — same upsert/revival/expiry
 * semantics — so the shared `runSourcing` pipeline behaves identically whether it writes locally or
 * to the central store. Writes require the service-role connection (RLS is bypassed by it); the
 * client never uses this class (it reads the public feed via PostgREST).
 *
 * `bigint` columns (`scans.id`, `last_seen_scan`) come back as strings from the driver, so they are
 * coerced with `Number`. SQL execution is validated by the opt-in `smoke:postgres` script, not unit
 * tests; the pure row mapping is unit-tested in `postgres-mappers.test.ts`.
 */
export class PostgresScanStore implements ScanStore {
  constructor(private readonly sql: Sql) {}

  async startScan(): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      INSERT INTO scans (started_at) VALUES (now()) RETURNING id`;
    return Number(rows[0]?.id);
  }

  async recordDirectory(scanId: number, companies: CompanyRef[]): Promise<DirectoryDiff> {
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

    const newCompanies = isBaseline ? [] : companies.filter((c) => !existingUrls.has(c.careersUrl));
    const removedCompanies =
      isBaseline || prevScan === null
        ? []
        : existing
            .filter((e) => Number(e.last_seen_scan) === prevScan && !currentUrls.has(e.careers_url))
            .map((e) => ({ careersUrl: e.careers_url, ...(e.name ? { name: e.name } : {}) }));

    for (const c of companies) {
      await this.sql`
        INSERT INTO companies (careers_url, name, first_seen_scan, last_seen_scan, last_seen_at)
        VALUES (${c.careersUrl}, ${c.name ?? null}, ${scanId}, ${scanId}, now())
        ON CONFLICT (careers_url) DO UPDATE SET
          name = excluded.name,
          last_seen_scan = excluded.last_seen_scan,
          last_seen_at = excluded.last_seen_at`;
    }

    return { newCompanies, removedCompanies };
  }

  async savePosting(posting: JobPosting, scanId: number | null = null): Promise<void> {
    const r = postingToRow(posting);
    await this.sql`
      INSERT INTO postings
        (id, company, title, url, source, description, location, posted_at, fetched_at,
         last_seen_scan, expired_at)
      VALUES (${r.id}, ${r.company}, ${r.title}, ${r.url}, ${r.source}, ${r.description},
         ${r.location}, ${r.posted_at}, ${r.fetched_at}, ${scanId}, NULL)
      ON CONFLICT (id) DO UPDATE SET
        company = excluded.company,
        title = excluded.title,
        url = excluded.url,
        source = excluded.source,
        description = excluded.description,
        location = excluded.location,
        posted_at = excluded.posted_at,
        fetched_at = excluded.fetched_at,
        last_seen_scan = COALESCE(excluded.last_seen_scan, postings.last_seen_scan),
        -- Revive a reappeared posting only when this save belongs to a scan.
        expired_at = CASE WHEN excluded.last_seen_scan IS NULL THEN postings.expired_at ELSE NULL END`;
  }

  async listLivePostingsNotSeen(scanId: number): Promise<JobPosting[]> {
    const rows = await this.sql<PostingRow[]>`
      SELECT id, company, title, url, source, description, location, posted_at, fetched_at
      FROM postings
      WHERE expired_at IS NULL AND (last_seen_scan IS NULL OR last_seen_scan != ${scanId})`;
    return rows.map(rowToPosting);
  }

  async markPostingExpired(postingId: string): Promise<boolean> {
    const rows = await this.sql`
      UPDATE postings SET expired_at = now()
      WHERE id = ${postingId} AND expired_at IS NULL
      RETURNING id`;
    return rows.length > 0;
  }

  async expireStalePostings(scanId: number, staleAfter = 2): Promise<number> {
    const rows = await this.sql`
      UPDATE postings SET expired_at = now()
      WHERE expired_at IS NULL AND last_seen_scan IS NOT NULL
        AND (${scanId} - last_seen_scan) >= ${staleAfter}
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

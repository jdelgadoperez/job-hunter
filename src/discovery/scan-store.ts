import type { JobPosting } from "@app/domain/types";
import type { CompanyRef } from "@app/storage/repository";

/** The directory delta a scan records (companies that appeared / disappeared vs. the prior scan). */
export type DirectoryDiff = { newCompanies: CompanyRef[]; removedCompanies: CompanyRef[] };

/**
 * The **sourcing** subset of `Repository`: exactly the writes the discover → persist → liveness →
 * finish pipeline needs, with no scoring (`saveMatchResult`) and no per-user state. The local
 * SQLite `Repository` satisfies this structurally today; a Postgres-backed store (the hosted scanner
 * worker) will too. Keeping `runSourcing` behind this seam lets the same pipeline target either
 * store — the central crawl writes postings the local client scores independently.
 *
 * Every method may be sync or async: better-sqlite3 is synchronous, but a Postgres driver is not.
 * The `T | Promise<T>` returns let the synchronous `Repository` satisfy the interface unchanged
 * while a `PostgresScanStore` returns promises; callers (`runSourcing`) `await` every call, which is
 * a no-op for the synchronous values.
 */
export interface ScanStore {
  startScan(): number | Promise<number>;
  recordDirectory(scanId: number, companies: CompanyRef[]): DirectoryDiff | Promise<DirectoryDiff>;
  savePosting(posting: JobPosting, scanId?: number | null): void | Promise<void>;
  /**
   * Optional bulk upsert of many postings in one round-trip — the same semantics as calling
   * `savePosting` for each, but a store backed by a network DB can collapse thousands of serial
   * round-trips into a handful of multi-row statements. `runSourcing` uses this when present and
   * falls back to the `savePosting` loop otherwise, so the synchronous SQLite `Repository` (which
   * has no round-trip cost) need not implement it.
   */
  savePostings?(postings: JobPosting[], scanId?: number | null): void | Promise<void>;
  listLivePostingsNotSeen(scanId: number): JobPosting[] | Promise<JobPosting[]>;
  markPostingExpired(postingId: string): boolean | Promise<boolean>;
  expireStalePostings(scanId: number, staleAfter?: number): number | Promise<number>;
  finishScan(
    scanId: number,
    summary: { postingsSeen: number; companiesSeen: number } & DirectoryDiff,
  ): void | Promise<void>;
}

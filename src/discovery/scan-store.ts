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
 */
export interface ScanStore {
  startScan(): number;
  recordDirectory(scanId: number, companies: CompanyRef[]): DirectoryDiff;
  savePosting(posting: JobPosting, scanId?: number | null): void;
  listLivePostingsNotSeen(scanId: number): JobPosting[];
  markPostingExpired(postingId: string): boolean;
  expireStalePostings(scanId: number, staleAfter?: number): number;
  finishScan(
    scanId: number,
    summary: { postingsSeen: number; companiesSeen: number } & DirectoryDiff,
  ): void;
}

import type { JobPosting } from "@app/domain/types";
import type { Fetcher } from "@app/net/fetcher";

/**
 * A connector turns one ATS board into normalized postings. Implementations are a
 * pure `(rawFeed) → JobPosting[]` transform wrapped by a thin `fetcher.fetch` step,
 * and never throw: a non-200 status or a feed that fails zod validation resolves to
 * `[]` (the orchestrator records the surrounding failure as a `Warning`).
 */
export interface AtsConnector {
  readonly source: string;
  fetchPostings(boardToken: string, fetcher: Fetcher): Promise<JobPosting[]>;
}

import type { JobPosting } from "@app/domain/types";
import type { Fetcher } from "@app/net/fetcher";

/**
 * Outcome of a connector fetch. Distinguishing `ok: false` (the feed could not be
 * fetched/parsed/validated) from `ok: true` with an empty `postings` array (the board
 * genuinely has no open roles) is what lets the orchestrator record a `Warning` for a
 * real failure instead of silently treating a 5xx as "no jobs".
 */
export type ConnectorResult = { ok: true; postings: JobPosting[] } | { ok: false; warning: string };

/**
 * A connector turns one ATS board into normalized postings. Implementations are a
 * pure `(rawFeed) → JobPosting[]` transform wrapped by a thin `fetcher.fetch` step and
 * never throw: any fetch/parse/validation failure resolves to `{ ok: false, warning }`,
 * which the orchestrator surfaces as a `Warning`.
 */
export interface AtsConnector {
  readonly source: string;
  fetchPostings(boardToken: string, fetcher: Fetcher): Promise<ConnectorResult>;
}

import type { JobPosting } from "@app/domain/types";
import type { Fetcher } from "@app/net/fetcher";
import type { ZodType } from "zod";
import { makePostingId } from "../posting-id";
import { fetchFeed } from "./fetch-feed";
import type { ConnectorResult } from "./types";

/** The connector-specific fields extracted from one raw job entry. */
type MappedJob = {
  title: string;
  url: string;
  description: string;
  location?: string;
  remote?: boolean;
};

/**
 * Shared body for the JSON-feed ATS connectors (Greenhouse/Lever/Ashby): fetch + validate the feed,
 * then map each job to a normalized `JobPosting`, stamping a single `fetchedAt` and a stable id.
 * Each connector supplies only what differs — the URL, the schema, how to reach the jobs array, and
 * the per-field mapping — so the "fetch → normalize" shape lives in one place.
 */
export async function fetchAtsPostings<Feed, Job>(
  fetcher: Fetcher,
  opts: {
    source: string;
    boardToken: string;
    url: string;
    schema: ZodType<Feed>;
    jobs: (feed: Feed) => Job[];
    map: (job: Job) => MappedJob;
  },
): Promise<ConnectorResult> {
  const result = await fetchFeed(fetcher, opts.url, opts.schema);
  if (!result.ok) return result;

  const fetchedAt = new Date();
  const postings: JobPosting[] = opts.jobs(result.data).map((job) => {
    const mapped = opts.map(job);
    return {
      id: makePostingId({ company: opts.boardToken, title: mapped.title, url: mapped.url }),
      company: opts.boardToken,
      title: mapped.title,
      url: mapped.url,
      source: opts.source,
      description: mapped.description,
      ...(mapped.location !== undefined ? { location: mapped.location } : {}),
      ...(mapped.remote !== undefined ? { remote: mapped.remote } : {}),
      fetchedAt,
    } satisfies JobPosting;
  });
  return { ok: true, postings };
}

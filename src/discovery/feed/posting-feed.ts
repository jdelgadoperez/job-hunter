import { rowToPosting } from "@app/backend/postgres-mappers";
import { fetchFeed } from "@app/discovery/connectors/fetch-feed";
import type { JobPosting, Warning } from "@app/domain/types";
import type { Fetcher } from "@app/net/fetcher";
import { z } from "zod";

const SOURCE = "feed";

/** What the remote feed yields: postings to score locally, plus any non-fatal warnings. */
export type PostingFeedResult = { postings: JobPosting[]; warnings: Warning[] };

/**
 * The shared posting feed the local client reads in remote mode: the central worker's deduplicated
 * postings, fetched instead of crawling. Mirrors the `LeadSource`/connector contract — degrade to a
 * `Warning`, never throw.
 */
export interface PostingFeed {
  fetch(): Promise<PostingFeedResult>;
}

// PostgREST returns the selected `postings` columns as a JSON array. Lenient on unknown fields,
// strict on what we read; timestamps are ISO strings, `location`/`posted_at` may be null.
const FeedRow = z
  .object({
    id: z.string(),
    company: z.string(),
    title: z.string(),
    url: z.string(),
    source: z.string(),
    description: z.string(),
    location: z.string().nullish(),
    remote: z.boolean().nullish(),
    country: z.string().nullish(),
    posted_at: z.string().nullish(),
    fetched_at: z.string(),
  })
  .passthrough();
const FeedRows = z.array(FeedRow);

const COLUMNS =
  "id,company,title,url,source,description,location,remote,country,posted_at,fetched_at";
const DEFAULT_LIMIT = 1000;

/**
 * Reads the shared feed from Supabase's PostgREST endpoint over the public `postings` table, sending
 * the anon key (read-only by RLS). Validates the rows, then maps them with the **same** `rowToPosting`
 * the worker's store round-trips through — so a posting's `id` is byte-identical whether it came from a
 * local crawl or the feed, keeping the client's saved scores / save-dismiss actions attached.
 */
export class HttpPostingFeed implements PostingFeed {
  constructor(
    private readonly opts: { fetcher: Fetcher; baseUrl: string; apiKey: string; limit?: number },
  ) {}

  async fetch(): Promise<PostingFeedResult> {
    const base = this.opts.baseUrl.replace(/\/+$/, "");
    const limit = this.opts.limit ?? DEFAULT_LIMIT;
    const url =
      `${base}/rest/v1/postings?select=${COLUMNS}` +
      `&expired_at=is.null&order=fetched_at.desc&limit=${limit}`;

    const result = await fetchFeed(this.opts.fetcher, url, FeedRows, {
      headers: { apikey: this.opts.apiKey, Authorization: `Bearer ${this.opts.apiKey}` },
    });
    if (!result.ok) {
      return { postings: [], warnings: [{ source: SOURCE, message: result.warning }] };
    }

    const postings = result.data.map((r) =>
      rowToPosting({
        id: r.id,
        company: r.company,
        title: r.title,
        url: r.url,
        source: r.source,
        description: r.description,
        location: r.location ?? null,
        remote: r.remote ?? null,
        country: r.country ?? null,
        posted_at: r.posted_at ?? null,
        fetched_at: r.fetched_at,
      }),
    );
    return { postings, warnings: [] };
  }
}

/** Test double: returns a canned result. Construct with the postings (and optional warnings). */
export class FakePostingFeed implements PostingFeed {
  constructor(private readonly result: PostingFeedResult) {}
  async fetch(): Promise<PostingFeedResult> {
    return this.result;
  }
}

import type { JobPosting } from "@app/domain/types";

/**
 * The domain columns of a `postings` row. Scan bookkeeping (last_seen_scan / expired_at) is the
 * store's concern, not the mapper's. Timestamps arrive as ISO strings (our inserts) or `Date`
 * objects (the postgres driver's default parsers), so reads coerce through `new Date`.
 */
export type PostingRow = {
  id: string;
  company: string;
  title: string;
  url: string;
  source: string;
  description: string;
  location: string | null;
  remote: boolean | null;
  country: string | null;
  posted_at: string | Date | null;
  fetched_at: string | Date;
};

/** The column values to INSERT for a posting (ISO strings; null for absent optionals). */
export type PostingInsert = {
  id: string;
  company: string;
  title: string;
  url: string;
  source: string;
  description: string;
  location: string | null;
  remote: boolean | null;
  country: string | null;
  posted_at: string | null;
  fetched_at: string;
};

/** JobPosting → the row we insert. Dates become ISO strings; absent optionals become NULL. */
export function postingToRow(posting: JobPosting): PostingInsert {
  return {
    id: posting.id,
    company: posting.company,
    title: posting.title,
    url: posting.url,
    source: posting.source,
    description: posting.description,
    location: posting.location ?? null,
    remote: posting.remote ?? null,
    country: posting.country ?? null,
    posted_at: posting.postedAt ? posting.postedAt.toISOString() : null,
    fetched_at: posting.fetchedAt.toISOString(),
  };
}

/** A postings row → JobPosting. Omits absent optionals and coerces timestamps to `Date`. */
export function rowToPosting(row: PostingRow): JobPosting {
  return {
    id: row.id,
    company: row.company,
    title: row.title,
    url: row.url,
    source: row.source,
    description: row.description,
    ...(row.location ? { location: row.location } : {}),
    ...(row.remote == null ? {} : { remote: row.remote }),
    ...(row.country ? { country: row.country } : {}),
    ...(row.posted_at ? { postedAt: new Date(row.posted_at) } : {}),
    fetchedAt: new Date(row.fetched_at),
  };
}

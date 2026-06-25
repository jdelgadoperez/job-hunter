import type { JobPosting } from "@app/domain/types";
import type { Fetcher } from "@app/net/fetcher";
import pLimit from "p-limit";
import { makePostingId } from "../posting-id";
import { fetchFeed } from "./fetch-feed";
import { RipplingFeed, RipplingJobDetail } from "./schemas";
import type { AtsConnector, ConnectorResult } from "./types";

const API_BASE = "https://ats.rippling.com/api/v2/board";
const PAGE_SIZE = 50;
const MAX_PAGES = 10; // bound a single company to ~500 roles
const DETAIL_CONCURRENCY = 6; // per-company cap on the follow-up description fetches

type RipplingJobRef = { id: string; title: string; url: string; location?: string };

/** Join one job's location names (Rippling lists one or more) into a single display string. */
function joinLocations(locations: { name: string }[] | undefined): string | undefined {
  const names = (locations ?? []).map((l) => l.name).filter(Boolean);
  return names.length > 0 ? names.join("; ") : undefined;
}

/**
 * Connector for Rippling-hosted boards (`ats.rippling.com/{slug}`). Rippling exposes a public JSON
 * jobs API (no auth) that the careers SPA itself calls, so these resolve fast like the other ATS
 * connectors instead of falling to the browser. The list endpoint omits the description, so each
 * posting's detail page is fetched (bounded concurrency) for the full text; a posting whose detail
 * can't be read falls back to title + location.
 *
 * `boardToken` here is the board slug (the first careers-URL path segment), which is also stamped as
 * each posting's `company` so liveness re-checks can re-derive the feed (see `connectorBySource`).
 */
export class RipplingConnector implements AtsConnector {
  readonly source = "rippling";

  async fetchPostings(slug: string, fetcher: Fetcher): Promise<ConnectorResult> {
    const listResult = await this.listJobs(slug, fetcher);
    if (!listResult.ok) return listResult;

    const fetchedAt = new Date();
    const limit = pLimit(DETAIL_CONCURRENCY);
    const postings = await Promise.all(
      listResult.jobs.map((job) =>
        limit(async () => {
          const description = await this.fetchDescription(slug, job, fetcher);
          return {
            id: makePostingId({ company: slug, title: job.title, url: job.url }),
            company: slug,
            title: job.title,
            url: job.url,
            source: this.source,
            description,
            location: job.location,
            fetchedAt,
          } satisfies JobPosting;
        }),
      ),
    );

    return { ok: true, postings };
  }

  /** Page through the jobs list, collecting job refs (id + title + url + location). */
  private async listJobs(
    slug: string,
    fetcher: Fetcher,
  ): Promise<{ ok: true; jobs: RipplingJobRef[] } | { ok: false; warning: string }> {
    const jobs: RipplingJobRef[] = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = `${API_BASE}/${slug}/jobs?page=${page}&pageSize=${PAGE_SIZE}`;
      const result = await fetchFeed(fetcher, url, RipplingFeed);
      if (!result.ok) {
        // A first-page failure is a real warning; a later page failing just truncates the list.
        return page === 0 ? result : { ok: true, jobs };
      }

      for (const job of result.data.items) {
        jobs.push({
          id: job.id,
          title: job.name,
          url: job.url,
          location: joinLocations(job.locations),
        });
      }

      const totalPages = result.data.totalPages;
      const done =
        result.data.items.length === 0 || (totalPages !== undefined && page + 1 >= totalPages);
      if (done) break;
    }

    return { ok: true, jobs };
  }

  /** Fetch a job's full description from its detail endpoint; fall back to title + location. */
  private async fetchDescription(
    slug: string,
    job: RipplingJobRef,
    fetcher: Fetcher,
  ): Promise<string> {
    const fallback = job.location ? `${job.title} — ${job.location}` : job.title;
    const detailUrl = `${API_BASE}/${slug}/jobs/${job.id}`;
    const result = await fetchFeed(fetcher, detailUrl, RipplingJobDetail);
    if (!result.ok) return fallback;
    const description = result.data.description.role?.trim();
    return description || fallback;
  }
}

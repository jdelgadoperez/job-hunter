import type { JobPosting } from "@app/domain/types";
import type { Fetcher } from "@app/net/fetcher";
import { makePostingId } from "../posting-id";
import { type FeedResult, fetchFeed } from "./fetch-feed";
import { WorkableFeed } from "./schemas";
import type { AtsConnector, ConnectorResult } from "./types";

const MAX_PAGES = 10; // bound on cursor-following so a runaway feed can't loop forever.

/** Join a Workable structured location (city/region/country) into a single display string. */
function joinLocation(location: WorkableFeed["results"][number]["location"]): string | undefined {
  const parts = [location?.city, location?.region, location?.country].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/**
 * Connector for Workable-hosted boards (`apply.workable.com/{token}`). Workable exposes a public v3
 * JSON API (no auth) that cursor-paginates via `nextPage`; this follows it up to `MAX_PAGES`,
 * accumulating results. A page that omits `url` gets one synthesized from its `shortcode`.
 *
 * `boardToken` is the account token (first careers-URL path segment), also stamped as each posting's
 * `company` so liveness re-checks can re-derive the feed (see `connectorBySource`).
 */
export class WorkableConnector implements AtsConnector {
  readonly source = "workable";

  async fetchPostings(token: string, fetcher: Fetcher): Promise<ConnectorResult> {
    let url: string | undefined = `https://apply.workable.com/api/v3/accounts/${token}/jobs`;
    const jobs: WorkableFeed["results"] = [];
    let pageCount = 0;

    while (url && pageCount < MAX_PAGES) {
      const result: FeedResult<WorkableFeed> = await fetchFeed(fetcher, url, WorkableFeed);
      if (!result.ok) return result;
      jobs.push(...result.data.results);
      url = result.data.nextPage ?? undefined;
      pageCount += 1;
    }

    const fetchedAt = new Date();
    const postings: JobPosting[] = jobs.map((job) => {
      const url = job.url ?? `https://apply.workable.com/${token}/j/${job.shortcode}/`;
      return {
        id: makePostingId({ company: token, title: job.title, url }),
        company: token,
        title: job.title,
        url,
        source: this.source,
        description: job.description ?? "",
        location: joinLocation(job.location),
        fetchedAt,
      };
    });

    return { ok: true, postings };
  }
}

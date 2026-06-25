import type { JobPosting } from "@app/domain/types";
import type { Fetcher } from "@app/net/fetcher";
import pLimit from "p-limit";
import { makePostingId } from "../posting-id";
import { fetchFeed } from "./fetch-feed";
import { BambooHrDetail, BambooHrFeed } from "./schemas";
import type { AtsConnector, ConnectorResult } from "./types";

const DETAIL_CONCURRENCY = 6; // per-company cap on the follow-up description fetches

type BambooHrJobRef = { id: string; title: string; location?: string };

/** Join a BambooHR structured location (city/state/country) into a single display string. */
function joinLocation(location: BambooHrFeed["result"][number]["atsLocation"]): string | undefined {
  const parts = [location?.city, location?.state, location?.country].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/**
 * Connector for BambooHR-hosted boards (`{slug}.bamboohr.com`). BambooHR exposes a public JSON
 * careers API (no auth). The list endpoint omits the description, so each posting's detail is fetched
 * (bounded concurrency) for the full text and its canonical share URL; a posting whose detail can't
 * be read falls back to title + location and a synthesized board URL.
 *
 * `boardToken` is the board slug (the careers-URL subdomain), also stamped as each posting's
 * `company` so liveness re-checks can re-derive the feed (see `connectorBySource`).
 */
export class BambooHrConnector implements AtsConnector {
  readonly source = "bamboohr";

  async fetchPostings(slug: string, fetcher: Fetcher): Promise<ConnectorResult> {
    const listUrl = `https://${slug}.bamboohr.com/careers/list`;
    const listResult = await fetchFeed(fetcher, listUrl, BambooHrFeed);
    if (!listResult.ok) return listResult;

    const refs: BambooHrJobRef[] = listResult.data.result.map((job) => ({
      id: job.id,
      title: job.jobOpeningName,
      location: joinLocation(job.atsLocation),
    }));

    const fetchedAt = new Date();
    const limit = pLimit(DETAIL_CONCURRENCY);
    const postings = await Promise.all(
      refs.map((ref) =>
        limit(async () => {
          const { description, url } = await this.fetchDetail(slug, ref, fetcher);
          return {
            id: makePostingId({ company: slug, title: ref.title, url }),
            company: slug,
            title: ref.title,
            url,
            source: this.source,
            description,
            location: ref.location,
            fetchedAt,
          } satisfies JobPosting;
        }),
      ),
    );

    return { ok: true, postings };
  }

  /**
   * Fetch a posting's full description and canonical share URL from its detail endpoint. Falls back
   * to a title/location description and a synthesized board URL when the detail can't be read.
   */
  private async fetchDetail(
    slug: string,
    ref: BambooHrJobRef,
    fetcher: Fetcher,
  ): Promise<{ description: string; url: string }> {
    const fallbackUrl = `https://${slug}.bamboohr.com/careers/${ref.id}`;
    const fallbackDescription = ref.location ? `${ref.title} — ${ref.location}` : ref.title;

    const detailUrl = `https://${slug}.bamboohr.com/careers/${ref.id}/detail`;
    const result = await fetchFeed(fetcher, detailUrl, BambooHrDetail);
    if (!result.ok) return { description: fallbackDescription, url: fallbackUrl };

    const opening = result.data.result.jobOpening;
    const description = opening.description?.trim();
    return {
      description: description || fallbackDescription,
      url: opening.jobOpeningShareUrl ?? fallbackUrl,
    };
  }
}

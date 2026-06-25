import type { JobPosting } from "@app/domain/types";
import type { Fetcher } from "@app/net/fetcher";
import pLimit from "p-limit";
import { makePostingId } from "../posting-id";
import { fetchFeed } from "./fetch-feed";
import { extractJsonLdDescription } from "./jsonld";
import { BreezyFeed } from "./schemas";
import type { AtsConnector, ConnectorResult } from "./types";

const DETAIL_CONCURRENCY = 6; // per-company cap on the follow-up description fetches

type BreezyJobRef = { title: string; url: string; location?: string };

/**
 * Connector for Breezy-hosted boards (`{slug}.breezy.hr`). Breezy's public `/json` list omits the
 * description, but each position page embeds it as JSON-LD — so we read it over plain HTTP and parse
 * the JSON-LD, instead of a full browser render. (The generic browser fallback already handles Breezy
 * via the same JSON-LD; this connector just makes those companies faster.) A position page that can't
 * be read falls back to title + location.
 *
 * `boardToken` is the board slug (the careers-URL subdomain), also stamped as each posting's
 * `company` so liveness re-checks can re-derive the feed (see `connectorBySource`).
 */
export class BreezyConnector implements AtsConnector {
  readonly source = "breezy";

  async fetchPostings(slug: string, fetcher: Fetcher): Promise<ConnectorResult> {
    const listUrl = `https://${slug}.breezy.hr/json`;
    const listResult = await fetchFeed(fetcher, listUrl, BreezyFeed);
    if (!listResult.ok) return listResult;

    const refs: BreezyJobRef[] = listResult.data.map((job) => ({
      title: job.name,
      url: job.url,
      location: job.location?.name ?? undefined,
    }));

    const fetchedAt = new Date();
    const limit = pLimit(DETAIL_CONCURRENCY);
    const postings = await Promise.all(
      refs.map((ref) =>
        limit(async () => {
          const description = await this.fetchDescription(ref, fetcher);
          return {
            id: makePostingId({ company: slug, title: ref.title, url: ref.url }),
            company: slug,
            title: ref.title,
            url: ref.url,
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

  /** Read a position page and pull its JSON-LD description; fall back to title + location. */
  private async fetchDescription(ref: BreezyJobRef, fetcher: Fetcher): Promise<string> {
    const fallback = ref.location ? `${ref.title} — ${ref.location}` : ref.title;
    try {
      const res = await fetcher.fetch(ref.url);
      if (res.statusCode < 200 || res.statusCode >= 300) return fallback;
      return extractJsonLdDescription(res.bodyText) ?? fallback;
    } catch {
      // A failed position-page fetch is inconclusive, not fatal — degrade to the fallback.
      return fallback;
    }
  }
}

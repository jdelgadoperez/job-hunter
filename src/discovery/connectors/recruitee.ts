import type { Fetcher } from "@app/net/fetcher";
import { fetchAtsPostings } from "./ats-feed";
import { RecruiteeFeed } from "./schemas";
import type { AtsConnector, ConnectorResult } from "./types";

/**
 * Connector for Recruitee-hosted boards (`{slug}.recruitee.com`). Recruitee's public offers API
 * already returns the full (HTML) description in the list response, so this is a simple feed
 * connector like Greenhouse/Lever/Ashby — no per-job detail fetch needed.
 *
 * `boardToken` is the board slug (the careers-URL subdomain).
 */
export class RecruiteeConnector implements AtsConnector {
  readonly source = "recruitee";

  fetchPostings(boardToken: string, fetcher: Fetcher): Promise<ConnectorResult> {
    return fetchAtsPostings(fetcher, {
      source: this.source,
      boardToken,
      url: `https://${boardToken}.recruitee.com/api/offers/`,
      schema: RecruiteeFeed,
      jobs: (feed) => feed.offers,
      map: (offer) => ({
        title: offer.title,
        url: offer.careers_url,
        description: offer.description ?? "",
        location: offer.location,
      }),
    });
  }
}

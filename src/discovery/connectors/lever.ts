import type { Fetcher } from "@app/net/fetcher";
import { fetchAtsPostings } from "./ats-feed";
import { LeverFeed } from "./schemas";
import type { AtsConnector, ConnectorResult } from "./types";

export class LeverConnector implements AtsConnector {
  readonly source = "lever";

  fetchPostings(boardToken: string, fetcher: Fetcher): Promise<ConnectorResult> {
    return fetchAtsPostings(fetcher, {
      source: this.source,
      boardToken,
      url: `https://api.lever.co/v0/postings/${boardToken}?mode=json`,
      schema: LeverFeed,
      jobs: (feed) => feed,
      map: (posting) => ({
        title: posting.text,
        url: posting.hostedUrl,
        description: posting.descriptionPlain ?? "",
        location: posting.categories?.location,
      }),
    });
  }
}

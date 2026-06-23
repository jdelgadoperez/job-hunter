import type { Fetcher } from "@app/net/fetcher";
import { fetchAtsPostings } from "./ats-feed";
import { GreenhouseFeed } from "./schemas";
import type { AtsConnector, ConnectorResult } from "./types";

export class GreenhouseConnector implements AtsConnector {
  readonly source = "greenhouse";

  fetchPostings(boardToken: string, fetcher: Fetcher): Promise<ConnectorResult> {
    return fetchAtsPostings(fetcher, {
      source: this.source,
      boardToken,
      url: `https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs?content=true`,
      schema: GreenhouseFeed,
      jobs: (feed) => feed.jobs,
      map: (job) => ({
        title: job.title,
        url: job.absolute_url,
        description: job.content ?? "",
        location: job.location?.name,
      }),
    });
  }
}

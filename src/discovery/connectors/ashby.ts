import type { Fetcher } from "@app/net/fetcher";
import { fetchAtsPostings } from "./ats-feed";
import { AshbyFeed } from "./schemas";
import type { AtsConnector, ConnectorResult } from "./types";

export class AshbyConnector implements AtsConnector {
  readonly source = "ashby";

  fetchPostings(boardToken: string, fetcher: Fetcher): Promise<ConnectorResult> {
    return fetchAtsPostings(fetcher, {
      source: this.source,
      boardToken,
      url: `https://api.ashbyhq.com/posting-api/job-board/${boardToken}`,
      schema: AshbyFeed,
      jobs: (feed) => feed.jobs,
      map: (job) => ({
        title: job.title,
        url: job.jobUrl,
        description: job.descriptionPlain ?? "",
        location: job.location,
        remote: job.isRemote,
      }),
    });
  }
}

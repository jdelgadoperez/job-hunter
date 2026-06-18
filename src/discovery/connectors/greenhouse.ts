import type { Fetcher } from "@app/net/fetcher";
import { makePostingId } from "../posting-id";
import { fetchFeed } from "./fetch-feed";
import { GreenhouseFeed } from "./schemas";
import type { AtsConnector, ConnectorResult } from "./types";

export class GreenhouseConnector implements AtsConnector {
  readonly source = "greenhouse";

  async fetchPostings(boardToken: string, fetcher: Fetcher): Promise<ConnectorResult> {
    const url = `https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs?content=true`;
    const result = await fetchFeed(fetcher, url, GreenhouseFeed);
    if (!result.ok) {
      return result;
    }

    const fetchedAt = new Date();
    const postings = result.data.jobs.map((job) => ({
      id: makePostingId({ company: boardToken, title: job.title, url: job.absolute_url }),
      company: boardToken,
      title: job.title,
      url: job.absolute_url,
      source: this.source,
      description: job.content ?? "",
      location: job.location?.name,
      fetchedAt,
    }));
    return { ok: true, postings };
  }
}

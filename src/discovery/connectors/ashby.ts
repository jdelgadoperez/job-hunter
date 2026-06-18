import type { Fetcher } from "@app/net/fetcher";
import { makePostingId } from "../posting-id";
import { fetchFeed } from "./fetch-feed";
import { AshbyFeed } from "./schemas";
import type { AtsConnector, ConnectorResult } from "./types";

export class AshbyConnector implements AtsConnector {
  readonly source = "ashby";

  async fetchPostings(boardToken: string, fetcher: Fetcher): Promise<ConnectorResult> {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${boardToken}`;
    const result = await fetchFeed(fetcher, url, AshbyFeed);
    if (!result.ok) {
      return result;
    }

    const fetchedAt = new Date();
    const postings = result.data.jobs.map((job) => ({
      id: makePostingId({ company: boardToken, title: job.title, url: job.jobUrl }),
      company: boardToken,
      title: job.title,
      url: job.jobUrl,
      source: this.source,
      description: job.descriptionPlain ?? "",
      location: job.location,
      fetchedAt,
    }));
    return { ok: true, postings };
  }
}

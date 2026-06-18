import type { JobPosting } from "@app/domain/types";
import type { Fetcher } from "@app/net/fetcher";
import { makePostingId } from "../posting-id";
import { AshbyFeed } from "./schemas";
import type { AtsConnector } from "./types";

export class AshbyConnector implements AtsConnector {
  readonly source = "ashby";

  async fetchPostings(boardToken: string, fetcher: Fetcher): Promise<JobPosting[]> {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${boardToken}`;
    const res = await fetcher.fetch(url);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      return [];
    }

    let raw: unknown;
    try {
      raw = JSON.parse(res.bodyText);
    } catch {
      return [];
    }

    const parsed = AshbyFeed.safeParse(raw);
    if (!parsed.success) {
      return [];
    }

    const fetchedAt = new Date();
    return parsed.data.jobs.map((job) => ({
      id: makePostingId({ company: boardToken, title: job.title, url: job.jobUrl }),
      company: boardToken,
      title: job.title,
      url: job.jobUrl,
      source: this.source,
      description: job.descriptionPlain ?? "",
      location: job.location,
      fetchedAt,
    }));
  }
}

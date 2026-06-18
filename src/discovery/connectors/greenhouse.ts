import type { JobPosting } from "@app/domain/types";
import type { Fetcher } from "@app/net/fetcher";
import { makePostingId } from "../posting-id";
import { GreenhouseFeed } from "./schemas";
import type { AtsConnector } from "./types";

export class GreenhouseConnector implements AtsConnector {
  readonly source = "greenhouse";

  async fetchPostings(boardToken: string, fetcher: Fetcher): Promise<JobPosting[]> {
    const url = `https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs?content=true`;
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

    const parsed = GreenhouseFeed.safeParse(raw);
    if (!parsed.success) {
      return [];
    }

    const fetchedAt = new Date();
    return parsed.data.jobs.map((job) => ({
      id: makePostingId({ company: boardToken, title: job.title, url: job.absolute_url }),
      company: boardToken,
      title: job.title,
      url: job.absolute_url,
      source: this.source,
      description: job.content ?? "",
      location: job.location?.name,
      fetchedAt,
    }));
  }
}

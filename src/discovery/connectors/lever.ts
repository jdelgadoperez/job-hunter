import type { JobPosting } from "@app/domain/types";
import type { Fetcher } from "@app/net/fetcher";
import { makePostingId } from "../posting-id";
import { LeverFeed } from "./schemas";
import type { AtsConnector } from "./types";

export class LeverConnector implements AtsConnector {
  readonly source = "lever";

  async fetchPostings(boardToken: string, fetcher: Fetcher): Promise<JobPosting[]> {
    const url = `https://api.lever.co/v0/postings/${boardToken}?mode=json`;
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

    const parsed = LeverFeed.safeParse(raw);
    if (!parsed.success) {
      return [];
    }

    const fetchedAt = new Date();
    return parsed.data.map((posting) => ({
      id: makePostingId({ company: boardToken, title: posting.text, url: posting.hostedUrl }),
      company: boardToken,
      title: posting.text,
      url: posting.hostedUrl,
      source: this.source,
      description: posting.descriptionPlain ?? "",
      location: posting.categories?.location,
      fetchedAt,
    }));
  }
}

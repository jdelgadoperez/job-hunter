import type { Fetcher } from "@app/net/fetcher";
import { makePostingId } from "../posting-id";
import { fetchFeed } from "./fetch-feed";
import { LeverFeed } from "./schemas";
import type { AtsConnector, ConnectorResult } from "./types";

export class LeverConnector implements AtsConnector {
  readonly source = "lever";

  async fetchPostings(boardToken: string, fetcher: Fetcher): Promise<ConnectorResult> {
    const url = `https://api.lever.co/v0/postings/${boardToken}?mode=json`;
    const result = await fetchFeed(fetcher, url, LeverFeed);
    if (!result.ok) {
      return result;
    }

    const fetchedAt = new Date();
    const postings = result.data.map((posting) => ({
      id: makePostingId({ company: boardToken, title: posting.text, url: posting.hostedUrl }),
      company: boardToken,
      title: posting.text,
      url: posting.hostedUrl,
      source: this.source,
      description: posting.descriptionPlain ?? "",
      location: posting.categories?.location,
      fetchedAt,
    }));
    return { ok: true, postings };
  }
}

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FakeFetcher } from "@app/net/fetcher";
import { describe, expect, it } from "vitest";
import { makePostingId } from "../posting-id";
import { AshbyConnector } from "./ashby";

const ENDPOINT = "https://api.ashbyhq.com/posting-api/job-board/acme";

async function fixtureBody(): Promise<string> {
  const path = fileURLToPath(new URL("./__fixtures__/ashby.json", import.meta.url));
  return readFile(path, "utf8");
}

describe("AshbyConnector", () => {
  it("maps a feed into normalized postings", async () => {
    const fetcher = new FakeFetcher({
      [ENDPOINT]: { statusCode: 200, finalUrl: ENDPOINT, bodyText: await fixtureBody() },
    });

    const postings = await new AshbyConnector().fetchPostings("acme", fetcher);

    expect(postings).toHaveLength(2);
    const [first] = postings;
    expect(first?.source).toBe("ashby");
    expect(first?.company).toBe("acme");
    expect(first?.title).toBe("Staff Frontend Engineer");
    expect(first?.url).toBe("https://jobs.ashbyhq.com/acme/c2b8e1d3-aaaa-4b3c-8d4e-000000000001");
    expect(first?.location).toBe("Remote - Worldwide");
    expect(first?.description).toContain("React");
    expect(first?.id).toBe(
      makePostingId({ company: "acme", title: first?.title ?? "", url: first?.url ?? "" }),
    );
    expect(first?.fetchedAt).toBeInstanceOf(Date);
  });

  it("returns [] for a malformed feed", async () => {
    const fetcher = new FakeFetcher({
      [ENDPOINT]: { statusCode: 200, finalUrl: ENDPOINT, bodyText: '{"jobs":[{"nope":true}]}' },
    });
    expect(await new AshbyConnector().fetchPostings("acme", fetcher)).toEqual([]);
  });

  it("returns [] for a non-200 status", async () => {
    const fetcher = new FakeFetcher({
      [ENDPOINT]: { statusCode: 503, finalUrl: ENDPOINT, bodyText: "" },
    });
    expect(await new AshbyConnector().fetchPostings("acme", fetcher)).toEqual([]);
  });
});

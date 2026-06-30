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

    const result = await new AshbyConnector().fetchPostings("acme", fetcher);
    if (!result.ok) {
      throw new Error("expected ok result");
    }
    expect(result.postings).toHaveLength(2);
    const [first] = result.postings;
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

  it("fails (not empty) for a malformed feed", async () => {
    const fetcher = new FakeFetcher({
      [ENDPOINT]: { statusCode: 200, finalUrl: ENDPOINT, bodyText: '{"jobs":[{"nope":true}]}' },
    });
    const result = await new AshbyConnector().fetchPostings("acme", fetcher);
    expect(result.ok).toBe(false);
  });

  it("fails for a non-200 status", async () => {
    const fetcher = new FakeFetcher({
      [ENDPOINT]: { statusCode: 503, finalUrl: ENDPOINT, bodyText: "" },
    });
    const result = await new AshbyConnector().fetchPostings("acme", fetcher);
    expect(result.ok).toBe(false);
  });
});

describe("AshbyConnector — remote field", () => {
  it("passes isRemote=true through to posting.remote", async () => {
    const feed = {
      jobs: [
        {
          id: "ar1",
          title: "Remote Engineer",
          jobUrl: "https://jobs.ashbyhq.com/acme/ar1",
          descriptionPlain: "desc",
          location: "Remote",
          isRemote: true,
        },
      ],
    };
    const fetcher = new FakeFetcher({
      [ENDPOINT]: {
        statusCode: 200,
        finalUrl: ENDPOINT,
        bodyText: JSON.stringify(feed),
      },
    });
    const result = await new AshbyConnector().fetchPostings("acme", fetcher);
    if (!result.ok) throw new Error("expected ok");
    expect(result.postings[0]?.remote).toBe(true);
  });

  it("passes isRemote=false through to posting.remote", async () => {
    const feed = {
      jobs: [
        {
          id: "ao1",
          title: "On-site Engineer",
          jobUrl: "https://jobs.ashbyhq.com/acme/ao1",
          descriptionPlain: "desc",
          location: "London, UK",
          isRemote: false,
        },
      ],
    };
    const fetcher = new FakeFetcher({
      [ENDPOINT]: {
        statusCode: 200,
        finalUrl: ENDPOINT,
        bodyText: JSON.stringify(feed),
      },
    });
    const result = await new AshbyConnector().fetchPostings("acme", fetcher);
    if (!result.ok) throw new Error("expected ok");
    expect(result.postings[0]?.remote).toBe(false);
  });

  it("leaves remote undefined when isRemote is absent", async () => {
    const feed = {
      jobs: [
        {
          id: "an1",
          title: "Unknown",
          jobUrl: "https://jobs.ashbyhq.com/acme/an1",
          descriptionPlain: "desc",
          location: "Berlin, Germany",
        },
      ],
    };
    const fetcher = new FakeFetcher({
      [ENDPOINT]: {
        statusCode: 200,
        finalUrl: ENDPOINT,
        bodyText: JSON.stringify(feed),
      },
    });
    const result = await new AshbyConnector().fetchPostings("acme", fetcher);
    if (!result.ok) throw new Error("expected ok");
    expect(result.postings[0]?.remote).toBeUndefined();
  });
});

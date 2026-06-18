import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FakeFetcher } from "@app/net/fetcher";
import { describe, expect, it } from "vitest";
import { makePostingId } from "../posting-id";
import { LeverConnector } from "./lever";

const ENDPOINT = "https://api.lever.co/v0/postings/acme?mode=json";

async function fixtureBody(): Promise<string> {
  const path = fileURLToPath(new URL("./__fixtures__/lever.json", import.meta.url));
  return readFile(path, "utf8");
}

describe("LeverConnector", () => {
  it("maps a feed into normalized postings", async () => {
    const fetcher = new FakeFetcher({
      [ENDPOINT]: { statusCode: 200, finalUrl: ENDPOINT, bodyText: await fixtureBody() },
    });

    const postings = await new LeverConnector().fetchPostings("acme", fetcher);

    expect(postings).toHaveLength(2);
    const [first] = postings;
    expect(first?.source).toBe("lever");
    expect(first?.company).toBe("acme");
    expect(first?.title).toBe("Backend Engineer");
    expect(first?.url).toBe("https://jobs.lever.co/acme/b1a9f0c2-1111-4a2b-9c3d-000000000001");
    expect(first?.location).toBe("Remote");
    expect(first?.description).toContain("Go");
    expect(first?.id).toBe(
      makePostingId({ company: "acme", title: first?.title ?? "", url: first?.url ?? "" }),
    );
    expect(first?.fetchedAt).toBeInstanceOf(Date);
  });

  it("returns [] for a malformed feed", async () => {
    const fetcher = new FakeFetcher({
      [ENDPOINT]: { statusCode: 200, finalUrl: ENDPOINT, bodyText: '[{"nope":true}]' },
    });
    expect(await new LeverConnector().fetchPostings("acme", fetcher)).toEqual([]);
  });

  it("returns [] for a non-200 status", async () => {
    const fetcher = new FakeFetcher({
      [ENDPOINT]: { statusCode: 404, finalUrl: ENDPOINT, bodyText: "" },
    });
    expect(await new LeverConnector().fetchPostings("acme", fetcher)).toEqual([]);
  });
});

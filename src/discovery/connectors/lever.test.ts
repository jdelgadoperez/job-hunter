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

    const result = await new LeverConnector().fetchPostings("acme", fetcher);
    if (!result.ok) {
      throw new Error("expected ok result");
    }
    expect(result.postings).toHaveLength(2);
    const [first] = result.postings;
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

  it("fails (not empty) for a malformed feed", async () => {
    const fetcher = new FakeFetcher({
      [ENDPOINT]: { statusCode: 200, finalUrl: ENDPOINT, bodyText: '[{"nope":true}]' },
    });
    const result = await new LeverConnector().fetchPostings("acme", fetcher);
    expect(result.ok).toBe(false);
  });

  it("fails for a non-200 status", async () => {
    const fetcher = new FakeFetcher({
      [ENDPOINT]: { statusCode: 404, finalUrl: ENDPOINT, bodyText: "" },
    });
    const result = await new LeverConnector().fetchPostings("acme", fetcher);
    expect(result.ok).toBe(false);
  });
});

describe("LeverConnector — remote field", () => {
  it('maps workplaceType "remote" to remote=true', async () => {
    const feed = [
      {
        id: "r1",
        text: "Remote Role",
        hostedUrl: "https://jobs.lever.co/acme/r1",
        descriptionPlain: "desc",
        categories: { location: "Remote" },
        workplaceType: "remote",
      },
    ];
    const fetcher = new FakeFetcher({
      [ENDPOINT]: {
        statusCode: 200,
        finalUrl: ENDPOINT,
        bodyText: JSON.stringify(feed),
      },
    });
    const result = await new LeverConnector().fetchPostings("acme", fetcher);
    if (!result.ok) throw new Error("expected ok");
    expect(result.postings[0]?.remote).toBe(true);
  });

  it('maps workplaceType "office" to remote=false', async () => {
    const feed = [
      {
        id: "o1",
        text: "Office Role",
        hostedUrl: "https://jobs.lever.co/acme/o1",
        descriptionPlain: "desc",
        categories: { location: "San Francisco, CA" },
        workplaceType: "office",
      },
    ];
    const fetcher = new FakeFetcher({
      [ENDPOINT]: {
        statusCode: 200,
        finalUrl: ENDPOINT,
        bodyText: JSON.stringify(feed),
      },
    });
    const result = await new LeverConnector().fetchPostings("acme", fetcher);
    if (!result.ok) throw new Error("expected ok");
    expect(result.postings[0]?.remote).toBe(false);
  });

  it("leaves remote undefined when workplaceType is absent", async () => {
    const feed = [
      {
        id: "n1",
        text: "No Workplace Type",
        hostedUrl: "https://jobs.lever.co/acme/n1",
        descriptionPlain: "desc",
        categories: { location: "New York, NY" },
      },
    ];
    const fetcher = new FakeFetcher({
      [ENDPOINT]: {
        statusCode: 200,
        finalUrl: ENDPOINT,
        bodyText: JSON.stringify(feed),
      },
    });
    const result = await new LeverConnector().fetchPostings("acme", fetcher);
    if (!result.ok) throw new Error("expected ok");
    expect(result.postings[0]?.remote).toBeUndefined();
  });
});

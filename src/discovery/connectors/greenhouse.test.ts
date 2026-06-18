import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FakeFetcher } from "@app/net/fetcher";
import { describe, expect, it } from "vitest";
import { makePostingId } from "../posting-id";
import { GreenhouseConnector } from "./greenhouse";

const ENDPOINT = "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true";

async function fixtureBody(): Promise<string> {
  const path = fileURLToPath(new URL("./__fixtures__/greenhouse.json", import.meta.url));
  return readFile(path, "utf8");
}

describe("GreenhouseConnector", () => {
  it("maps a feed into normalized postings", async () => {
    const fetcher = new FakeFetcher({
      [ENDPOINT]: { statusCode: 200, finalUrl: ENDPOINT, bodyText: await fixtureBody() },
    });

    const postings = await new GreenhouseConnector().fetchPostings("acme", fetcher);

    expect(postings).toHaveLength(2);
    const [first] = postings;
    expect(first?.source).toBe("greenhouse");
    expect(first?.company).toBe("acme");
    expect(first?.title).toBe("Senior Software Engineer");
    expect(first?.url).toBe("https://boards.greenhouse.io/acme/jobs/5612345");
    expect(first?.location).toBe("Remote - US");
    expect(first?.description).toContain("TypeScript");
    expect(first?.id).toBe(
      makePostingId({ company: "acme", title: first?.title ?? "", url: first?.url ?? "" }),
    );
    expect(first?.fetchedAt).toBeInstanceOf(Date);
  });

  it("returns [] for a malformed feed", async () => {
    const fetcher = new FakeFetcher({
      [ENDPOINT]: { statusCode: 200, finalUrl: ENDPOINT, bodyText: '{"jobs":[{"nope":true}]}' },
    });
    expect(await new GreenhouseConnector().fetchPostings("acme", fetcher)).toEqual([]);
  });

  it("returns [] for a non-200 status", async () => {
    const fetcher = new FakeFetcher({
      [ENDPOINT]: { statusCode: 500, finalUrl: ENDPOINT, bodyText: "" },
    });
    expect(await new GreenhouseConnector().fetchPostings("acme", fetcher)).toEqual([]);
  });
});

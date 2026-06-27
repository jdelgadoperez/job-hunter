import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Fetcher } from "@app/net/fetcher";
import { describe, expect, it } from "vitest";
import { WorkableConnector } from "./workable";

function fixture(name: string): string {
  return readFileSync(join(__dirname, "__fixtures__", name), "utf8");
}

/** A Fetcher that serves page1 then page2 by URL, and can be told to fail a given URL. */
function pagedFetcher(opts: { failUrl?: string } = {}): Fetcher {
  return {
    fetch: async (url: string) => {
      if (opts.failUrl && url === opts.failUrl)
        return { statusCode: 500, bodyText: "", finalUrl: url };
      const body = url.includes("page=2")
        ? fixture("workable-page2.json")
        : fixture("workable-page1.json");
      return { statusCode: 200, bodyText: body, finalUrl: url };
    },
  };
}

describe("WorkableConnector", () => {
  it("follows nextPage and accumulates results across pages", async () => {
    const page1 = JSON.parse(fixture("workable-page1.json")) as { results: { title: string }[] };
    const page2 = JSON.parse(fixture("workable-page2.json")) as { results: { title: string }[] };
    const connector = new WorkableConnector();

    const result = await connector.fetchPostings("acme", pagedFetcher());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.postings).toHaveLength(page1.results.length + page2.results.length);
      expect(result.postings.map((p) => p.title)).toContain(page2.results[0]?.title);
      // company is stamped with the board token for liveness re-checks.
      expect(result.postings.every((p) => p.company === "acme")).toBe(true);
    }
  });

  it("synthesizes a url from shortcode when url is absent and joins the location", async () => {
    const connector = new WorkableConnector();
    const result = await connector.fetchPostings("acme", pagedFetcher());

    expect(result.ok).toBe(true);
    if (result.ok) {
      const designer = result.postings.find((p) => p.title === "Product Designer");
      expect(designer?.url).toBe("https://apply.workable.com/acme/j/DEF456/");
      const backend = result.postings.find((p) => p.title === "Senior Backend Engineer");
      expect(backend?.location).toBe("Berlin, Germany");
    }
  });

  it("returns ok:false when a page fetch fails", async () => {
    const connector = new WorkableConnector();
    // Fail the first page request.
    const firstUrl = "https://apply.workable.com/api/v3/accounts/acme/jobs";
    const result = await connector.fetchPostings("acme", pagedFetcher({ failUrl: firstUrl }));

    expect(result.ok).toBe(false);
  });
});

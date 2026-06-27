import { readFileSync } from "node:fs";
import { join } from "node:path";
import { THE_MUSE_KEY_SETTING } from "@app/matching/settings-keys";
import type { Fetcher } from "@app/net/fetcher";
import { describe, expect, it } from "vitest";
import { TheMuseSource } from "./themuse";
import type { LeadSourceDeps } from "./types";

function fixture(name: string): string {
  return readFileSync(join(__dirname, "__fixtures__", name), "utf8");
}

/** Deps with a configurable key and an injectable fetcher; sources only touch these two here. */
function deps(opts: { key?: string; fetcher: Fetcher }): LeadSourceDeps {
  return {
    fetcher: opts.fetcher,
    settings: { getSetting: (k) => (k === THE_MUSE_KEY_SETTING ? opts.key : undefined) },
    sharedViewReader: { read: async () => ({}) },
    shareUrl: "",
  };
}

/** Serves page0 then page1 by the `page=` query param; optionally fails/garbles a given page. */
function pagedFetcher(opts: { fail?: number; garble?: number } = {}): Fetcher {
  return {
    fetch: async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page"));
      if (opts.fail === page) return { statusCode: 503, finalUrl: url, bodyText: "" };
      if (opts.garble === page) return { statusCode: 200, finalUrl: url, bodyText: "{not json" };
      return { statusCode: 200, finalUrl: url, bodyText: fixture(`themuse-page${page}.json`) };
    },
  };
}

describe("TheMuseSource", () => {
  it("self-skips with a warning and makes no request when no key is configured", async () => {
    const source = new TheMuseSource();
    const fetcher: Fetcher = {
      fetch: async () => {
        throw new Error("must not fetch without a key");
      },
    };

    const result = await source.fetch(deps({ fetcher }));

    expect(result.leads).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.source).toBe("themuse");
  });

  it("follows pagination and maps company/url/categories, skipping blank landing pages", async () => {
    const page0 = JSON.parse(fixture("themuse-page0.json")) as {
      results: {
        company: { name: string };
        refs: { landing_page: string };
        categories: { name: string }[];
      }[];
    };
    const page1 = JSON.parse(fixture("themuse-page1.json")) as {
      results: { refs: { landing_page: string } }[];
    };
    const withLanding = [...page0.results, ...page1.results].filter(
      (r) => r.refs.landing_page !== "",
    );

    const source = new TheMuseSource();
    const result = await source.fetch(deps({ key: "k", fetcher: pagedFetcher() }));

    expect(result.warnings).toEqual([]);
    // One lead per listing that has a landing page, across both pages (blank one dropped).
    expect(result.leads).toHaveLength(withLanding.length);
    expect(result.leads.map((l) => l.careersUrl)).toEqual(
      withLanding.map((r) => r.refs.landing_page),
    );

    const acme = page0.results[0];
    const acmeLead = result.leads.find((l) => l.careersUrl === acme?.refs.landing_page);
    expect(acmeLead?.company).toBe(acme?.company.name);
    expect(acmeLead?.categories).toEqual(acme?.categories.map((c) => c.name));
  });

  it("passes the api key in the request", async () => {
    const seen: string[] = [];
    const source = new TheMuseSource();
    const fetcher: Fetcher = {
      fetch: async (url: string) => {
        seen.push(url);
        // page_count 2 but this fixture is page=1, so pagination stops after one request.
        return { statusCode: 200, finalUrl: url, bodyText: fixture("themuse-page1.json") };
      },
    };

    await source.fetch(deps({ key: "secret-key", fetcher }));

    expect(seen.every((u) => new URL(u).searchParams.get("api_key") === "secret-key")).toBe(true);
  });

  it("degrades to partial leads + a warning when a page fetch fails mid-pagination", async () => {
    const source = new TheMuseSource();
    // page0 ok, page1 fails → keep page0's leads, warn, do not throw.
    const result = await source.fetch(deps({ key: "k", fetcher: pagedFetcher({ fail: 1 }) }));

    expect(result.leads.length).toBeGreaterThan(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.source).toBe("themuse");
  });

  it("degrades to a warning on a malformed first page", async () => {
    const source = new TheMuseSource();
    const result = await source.fetch(deps({ key: "k", fetcher: pagedFetcher({ garble: 0 }) }));

    expect(result.leads).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.source).toBe("themuse");
  });
});

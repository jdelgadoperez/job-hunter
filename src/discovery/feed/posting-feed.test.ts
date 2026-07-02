import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Fetcher, FetchResponse } from "@app/net/fetcher";
import { describe, expect, it } from "vitest";
import { HttpPostingFeed } from "./posting-feed";

const FIXTURE = readFileSync(join(__dirname, "__fixtures__", "feed-postings.json"), "utf8");

/** A Fetcher that records the request and returns a canned response. */
function recordingFetcher(response: FetchResponse): {
  fetcher: Fetcher;
  calls: { url: string; headers?: Record<string, string> }[];
} {
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  const fetcher: Fetcher = {
    fetch: async (url, init) => {
      calls.push({ url, headers: init?.headers });
      return response;
    },
  };
  return { fetcher, calls };
}

function ok(bodyText: string): FetchResponse {
  return { statusCode: 200, finalUrl: "https://x", bodyText };
}

const opts = (fetcher: Fetcher) => ({
  fetcher,
  baseUrl: "https://proj.supabase.co",
  apiKey: "anon-key",
});

describe("HttpPostingFeed", () => {
  it("maps PostgREST rows to JobPostings, preserving id and fields", async () => {
    const rows = JSON.parse(FIXTURE) as {
      id: string;
      location: string | null;
      posted_at: string | null;
    }[];
    const { fetcher } = recordingFetcher(ok(FIXTURE));

    const { postings, warnings } = await new HttpPostingFeed(opts(fetcher)).fetch();

    expect(warnings).toEqual([]);
    expect(postings.map((p) => p.id)).toEqual(rows.map((r) => r.id));
    // Null location / posted_at become absent optionals; a present location is kept.
    const withLoc = postings.find((p) => p.id === rows[0]?.id);
    expect(withLoc?.location).toBe("Remote - US");
    const withoutLoc = postings.find((p) => p.id === rows[1]?.id);
    expect("location" in (withoutLoc ?? {})).toBe(false);
    expect("postedAt" in (withoutLoc ?? {})).toBe(false);
    expect(withLoc?.fetchedAt).toBeInstanceOf(Date);
  });

  it("requests live postings newest-first and sends the anon key in both headers", async () => {
    const { fetcher, calls } = recordingFetcher(ok(FIXTURE));
    await new HttpPostingFeed(opts(fetcher)).fetch();

    const call = calls[0];
    expect(call?.url).toContain("/rest/v1/postings");
    expect(call?.url).toContain("expired_at=is.null");
    expect(call?.url).toContain("order=fetched_at.desc");
    expect(call?.headers?.apikey).toBe("anon-key");
    expect(call?.headers?.Authorization).toBe("Bearer anon-key");
  });

  it("degrades to a warning on a non-2xx response", async () => {
    const { fetcher } = recordingFetcher({ statusCode: 401, finalUrl: "https://x", bodyText: "" });
    const result = await new HttpPostingFeed(opts(fetcher)).fetch();
    expect(result.postings).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.source).toBe("feed");
  });

  it("degrades to a warning on a malformed payload", async () => {
    const { fetcher } = recordingFetcher(ok('{"not":"an array"}'));
    const result = await new HttpPostingFeed(opts(fetcher)).fetch();
    expect(result.postings).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.source).toBe("feed");
  });

  it("maps a feed row's company_id to companyId", async () => {
    const body = JSON.stringify([
      {
        id: "a",
        company: "Acme",
        title: "T",
        url: "u",
        source: "s",
        description: "d",
        fetched_at: "2026-07-02T00:00:00Z",
        company_id: "abc123def4567890",
      },
    ]);
    const { fetcher } = recordingFetcher(ok(body));
    const { postings } = await new HttpPostingFeed(opts(fetcher)).fetch();
    expect(postings[0]?.companyId).toBe("abc123def4567890");
  });

  it("validates and maps a feed row that lacks company_id (old worker) to undefined", async () => {
    const body = JSON.stringify([
      {
        id: "a",
        company: "Acme",
        title: "T",
        url: "u",
        source: "s",
        description: "d",
        fetched_at: "2026-07-02T00:00:00Z",
        // no company_id
      },
    ]);
    const { fetcher } = recordingFetcher(ok(body));
    const result = await new HttpPostingFeed(opts(fetcher)).fetch();
    expect(result.warnings).toEqual([]); // did NOT degrade to a warning/empty result
    expect(result.postings[0]?.companyId).toBeUndefined();
  });
});

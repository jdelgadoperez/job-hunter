import { GreenhouseConnector } from "@app/discovery/connectors/greenhouse";
import type { JobPosting } from "@app/domain/types";
import { FakeFetcher } from "@app/net/fetcher";
import { describe, expect, it } from "vitest";
import { detectLiveness } from "./detect-liveness";
import { fetchLivenessSignal } from "./fetch-liveness";

const GH_ENDPOINT = "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true";

function greenhouseBody(): string {
  return JSON.stringify({
    jobs: [
      {
        title: "Senior Software Engineer",
        absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
        content: "role",
      },
    ],
  });
}

async function acmePosting(): Promise<JobPosting> {
  const fetcher = new FakeFetcher({
    [GH_ENDPOINT]: { statusCode: 200, finalUrl: GH_ENDPOINT, bodyText: greenhouseBody() },
  });
  const result = await new GreenhouseConnector().fetchPostings("acme", fetcher);
  const posting = result.ok ? result.postings[0] : undefined;
  if (!posting) {
    throw new Error("fixture did not yield a posting");
  }
  return posting;
}

describe("fetchLivenessSignal", () => {
  it("reports an ATS posting still in the feed as live", async () => {
    const posting = await acmePosting();
    const fetcher = new FakeFetcher({
      [GH_ENDPOINT]: { statusCode: 200, finalUrl: GH_ENDPOINT, bodyText: greenhouseBody() },
    });
    const signal = await fetchLivenessSignal(posting, { fetcher });
    expect(signal).toEqual({ kind: "ats-feed", feedAvailable: true, postingPresent: true });
    expect(detectLiveness(signal)).toBe("live");
  });

  it("reports an ATS posting absent from the feed as expired", async () => {
    const posting = await acmePosting();
    const emptyFeed = JSON.stringify({ jobs: [] });
    const fetcher = new FakeFetcher({
      [GH_ENDPOINT]: { statusCode: 200, finalUrl: GH_ENDPOINT, bodyText: emptyFeed },
    });
    const signal = await fetchLivenessSignal(posting, { fetcher });
    expect(signal).toEqual({ kind: "ats-feed", feedAvailable: true, postingPresent: false });
    expect(detectLiveness(signal)).toBe("expired");
  });

  it("reports a transient ATS feed failure as unknown, not expired", async () => {
    const posting = await acmePosting();
    // Board API 503s on the re-check: the feed is unavailable, not proof of removal.
    const fetcher = new FakeFetcher({
      [GH_ENDPOINT]: { statusCode: 503, finalUrl: GH_ENDPOINT, bodyText: "" },
    });
    const signal = await fetchLivenessSignal(posting, { fetcher });
    expect(signal).toEqual({ kind: "ats-feed", feedAvailable: false, postingPresent: false });
    expect(detectLiveness(signal)).toBe("unknown");
  });

  it("reports a browser posting returning 404 as expired", async () => {
    const posting: JobPosting = {
      id: "abc123",
      company: "Acme",
      title: "Designer",
      url: "https://acme.com/careers/designer",
      source: "browser",
      description: "",
      fetchedAt: new Date(),
    };
    const fetcher = new FakeFetcher({}); // unknown url → 404
    const signal = await fetchLivenessSignal(posting, { fetcher });
    expect(signal.kind).toBe("http");
    expect(detectLiveness(signal)).toBe("expired");
  });

  it("treats a re-fetch that throws as unknown rather than crashing", async () => {
    const posting: JobPosting = {
      id: "def456",
      company: "Acme",
      title: "Designer",
      url: "https://acme.com/careers/designer",
      source: "browser",
      description: "",
      fetchedAt: new Date(),
    };
    const throwingFetcher = {
      fetch: () => Promise.reject(new Error("network down")),
    };
    const signal = await fetchLivenessSignal(posting, { fetcher: throwingFetcher });
    expect(signal).toEqual({
      kind: "http",
      statusCode: 0,
      finalUrl: posting.url,
      originalUrl: posting.url,
      bodyText: "",
    });
    expect(detectLiveness(signal)).toBe("unknown");
  });
});

import { GreenhouseConnector } from "@app/discovery/connectors/greenhouse";
import type { JobPosting } from "@app/domain/types";
import { FakeFetcher, type Fetcher, type FetchResponse } from "@app/net/fetcher";
import { describe, expect, it } from "vitest";
import { detectLiveness } from "./detect-liveness";
import { fetchLivenessSignal, fetchLivenessSignalsForBoard } from "./fetch-liveness";

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

/** Wraps a fetcher to record how many times each URL was requested. */
class CountingFetcher implements Fetcher {
  readonly counts = new Map<string, number>();
  constructor(private readonly inner: Fetcher) {}
  fetch(url: string, options?: Parameters<Fetcher["fetch"]>[1]): Promise<FetchResponse> {
    this.counts.set(url, (this.counts.get(url) ?? 0) + 1);
    return this.inner.fetch(url, options);
  }
}

describe("fetchLivenessSignalsForBoard", () => {
  it("fetches an ATS board feed once for many postings and dedupes presence per posting", async () => {
    const present = await acmePosting();
    const gone: JobPosting = { ...present, id: "stale-id" };
    const fetcher = new CountingFetcher(
      new FakeFetcher({
        [GH_ENDPOINT]: { statusCode: 200, finalUrl: GH_ENDPOINT, bodyText: greenhouseBody() },
      }),
    );

    const signals = await fetchLivenessSignalsForBoard(present.source, "acme", [present, gone], {
      fetcher,
    });

    expect(fetcher.counts.get(GH_ENDPOINT)).toBe(1);
    expect(detectLiveness(signals.get(present.id) ?? unreachable())).toBe("live");
    expect(detectLiveness(signals.get(gone.id) ?? unreachable())).toBe("expired");
  });

  it("marks every posting unknown when the shared feed is unavailable", async () => {
    const posting = await acmePosting();
    const other: JobPosting = { ...posting, id: "second-id" };
    const fetcher = new FakeFetcher({
      [GH_ENDPOINT]: { statusCode: 503, finalUrl: GH_ENDPOINT, bodyText: "" },
    });

    const signals = await fetchLivenessSignalsForBoard(posting.source, "acme", [posting, other], {
      fetcher,
    });

    for (const signal of signals.values()) {
      expect(signal).toEqual({ kind: "ats-feed", feedAvailable: false, postingPresent: false });
      expect(detectLiveness(signal)).toBe("unknown");
    }
  });

  it("falls back to a per-posting HTTP re-check for sources without a board connector", async () => {
    const live: JobPosting = {
      id: "live-url",
      company: "Acme",
      title: "Designer",
      url: "https://acme.com/careers/live",
      source: "browser",
      description: "",
      fetchedAt: new Date(),
    };
    const gone: JobPosting = { ...live, id: "gone-url", url: "https://acme.com/careers/gone" };
    const fetcher = new FakeFetcher({
      [live.url]: { statusCode: 200, finalUrl: live.url, bodyText: "Designer role" },
      // gone.url is unrouted → 404 → expired
    });

    const signals = await fetchLivenessSignalsForBoard("browser", "Acme", [live, gone], {
      fetcher,
    });

    expect(detectLiveness(signals.get(live.id) ?? unreachable())).toBe("live");
    expect(detectLiveness(signals.get(gone.id) ?? unreachable())).toBe("expired");
  });
});

function unreachable(): never {
  throw new Error("expected a signal for every posting id");
}

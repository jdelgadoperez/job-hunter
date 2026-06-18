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
  const [posting] = await new GreenhouseConnector().fetchPostings("acme", fetcher);
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
    expect(signal).toEqual({ kind: "ats-feed", postingPresent: true });
    expect(detectLiveness(signal)).toBe("live");
  });

  it("reports an ATS posting absent from the feed as expired", async () => {
    const posting = await acmePosting();
    const emptyFeed = JSON.stringify({ jobs: [] });
    const fetcher = new FakeFetcher({
      [GH_ENDPOINT]: { statusCode: 200, finalUrl: GH_ENDPOINT, bodyText: emptyFeed },
    });
    const signal = await fetchLivenessSignal(posting, { fetcher });
    expect(signal).toEqual({ kind: "ats-feed", postingPresent: false });
    expect(detectLiveness(signal)).toBe("expired");
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
});

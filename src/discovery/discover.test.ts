import type { SkillProfile } from "@app/domain/types";
import type { FetchResponse, Fetcher } from "@app/net/fetcher";
import { describe, expect, it } from "vitest";
import type { PageRenderer } from "./connectors/browser";
import { discover } from "./discover";
import { STILLHIRING_URL } from "./sources/stillhiring";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tracks how many fetch/render calls overlap so the test can assert the cap. */
class Gauge {
  active = 0;
  max = 0;
  async track<T>(fn: () => Promise<T>): Promise<T> {
    this.active += 1;
    this.max = Math.max(this.max, this.active);
    try {
      await sleep(5);
      return await fn();
    } finally {
      this.active -= 1;
    }
  }
}

function greenhouseFeed(token: string): string {
  return JSON.stringify({
    jobs: [
      {
        title: `Engineer at ${token}`,
        absolute_url: `https://boards.greenhouse.io/${token}/jobs/1`,
        content: "TypeScript role",
        location: { name: "Remote" },
      },
    ],
  });
}

const STILLHIRING_BODY = JSON.stringify({
  companies: [
    { name: "Acme", careersUrl: "https://boards.greenhouse.io/acme", categories: [] },
    { name: "Globex", careersUrl: "https://boards.greenhouse.io/globex", categories: [] },
    { name: "Initech", careersUrl: "https://initech.com/careers", categories: [] },
    { name: "Boom", careersUrl: "https://boom.com/careers", categories: [] },
  ],
});

class GaugedFetcher implements Fetcher {
  constructor(
    private readonly routes: Record<string, string>,
    private readonly gauge: Gauge,
  ) {}
  async fetch(url: string): Promise<FetchResponse> {
    return this.gauge.track(async () => {
      const body = this.routes[url];
      return body === undefined
        ? { statusCode: 404, finalUrl: url, bodyText: "" }
        : { statusCode: 200, finalUrl: url, bodyText: body };
    });
  }
}

class GaugedRenderer implements PageRenderer {
  constructor(
    private readonly html: string,
    private readonly throwFor: string,
    private readonly gauge: Gauge,
  ) {}
  async render(url: string): Promise<string> {
    return this.gauge.track(async () => {
      if (url === this.throwFor) {
        throw new Error("render crashed");
      }
      return this.html;
    });
  }
}

const JSONLD_HTML = `<script type="application/ld+json">${JSON.stringify({
  "@type": "JobPosting",
  title: "Operations Lead",
  url: "https://initech.com/careers/ops",
  description: "Run the office.",
})}</script>`;

const profile: SkillProfile = { skills: [], roleKeywords: [], categories: [] };

describe("discover", () => {
  it("aggregates ATS + browser postings, records per-company failures, and caps concurrency", async () => {
    const gauge = new Gauge();
    const fetcher = new GaugedFetcher(
      {
        [STILLHIRING_URL]: STILLHIRING_BODY,
        "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": greenhouseFeed("acme"),
        "https://boards-api.greenhouse.io/v1/boards/globex/jobs?content=true":
          greenhouseFeed("globex"),
      },
      gauge,
    );
    const renderer = new GaugedRenderer(JSONLD_HTML, "https://boom.com/careers", gauge);

    const { postings, warnings } = await discover(profile, {
      fetcher,
      renderer,
      concurrency: 2,
      delayMs: 0,
    });

    const titles = postings.map((p) => p.title).sort();
    expect(titles).toEqual(["Engineer at acme", "Engineer at globex", "Operations Lead"]);

    // The crashing company surfaces as a warning, but the others still return postings.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.source).toBe("Boom");

    // Concurrency never exceeds the cap, and work genuinely overlapped.
    expect(gauge.max).toBeLessThanOrEqual(2);
    expect(gauge.max).toBeGreaterThan(1);
  });

  it("de-duplicates postings that resolve to the same id", async () => {
    const gauge = new Gauge();
    const feed = JSON.stringify({
      companies: [
        { name: "acme", careersUrl: "https://boards.greenhouse.io/acme", categories: [] },
        { name: "acme", careersUrl: "https://boards.greenhouse.io/acme", categories: [] },
      ],
    });
    const fetcher = new GaugedFetcher(
      {
        [STILLHIRING_URL]: feed,
        "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": greenhouseFeed("acme"),
      },
      gauge,
    );
    const renderer = new GaugedRenderer("", "", gauge);

    const { postings } = await discover(profile, { fetcher, renderer, delayMs: 0 });
    expect(postings).toHaveLength(1);
  });
});

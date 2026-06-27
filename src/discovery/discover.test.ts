import type { ScanProgressEvent } from "@app/domain/scan-progress";
import type { FetchResponse, Fetcher } from "@app/net/fetcher";
import { describe, expect, it } from "vitest";
import type { PageRenderer } from "./connectors/browser";
import { discover } from "./discover";
import { FakeSharedViewReader } from "./sources/airtable";
import { AirtableSource } from "./sources/airtable-source";
import type { LeadSource } from "./sources/types";

const SHARE_URL = "https://airtable.com/appX/shrX/tblX";

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

/** Builds an Airtable readSharedViewData payload from a list of company → careers-URL pairs. */
function airtableData(companies: { name: string; url: string }[]): unknown {
  return {
    data: {
      table: {
        columns: [
          { id: "c1", name: "™" },
          { id: "c2", name: "Jobs Page" },
        ],
        rows: companies.map((c, i) => ({
          id: `rec${i}`,
          cellValuesByColumnId: { c1: c.name, c2: c.url },
        })),
      },
    },
  };
}

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

describe("discover", () => {
  it("aggregates ATS + browser postings, records per-company failures, and caps concurrency", async () => {
    const gauge = new Gauge();
    const reader = new FakeSharedViewReader(
      airtableData([
        { name: "Acme", url: "https://boards.greenhouse.io/acme" },
        { name: "Globex", url: "https://boards.greenhouse.io/globex" },
        { name: "Initech", url: "https://initech.com/careers" },
        { name: "Boom", url: "https://boom.com/careers" },
      ]),
    );
    const fetcher = new GaugedFetcher(
      {
        "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": greenhouseFeed("acme"),
        "https://boards-api.greenhouse.io/v1/boards/globex/jobs?content=true":
          greenhouseFeed("globex"),
      },
      gauge,
    );
    const renderer = new GaugedRenderer(JSONLD_HTML, "https://boom.com/careers", gauge);

    const { postings, warnings } = await discover({
      fetcher,
      renderer,
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      concurrency: 2,
      delayMs: 0,
      settings: { getSetting: () => undefined },
      sources: [new AirtableSource()],
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

  it("skips un-scrapable hosts (LinkedIn) without rendering, and surfaces them for review", async () => {
    const rendered: string[] = [];
    const renderer: PageRenderer = {
      async render(url) {
        rendered.push(url);
        return JSONLD_HTML;
      },
    };
    const reader = new FakeSharedViewReader(
      airtableData([
        { name: "Acme", url: "https://boards.greenhouse.io/acme" },
        { name: "BigCo", url: "https://www.linkedin.com/company/bigco/jobs/" },
        { name: "Initech", url: "https://initech.com/careers" },
      ]),
    );
    const fetcher = new GaugedFetcher(
      {
        "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": greenhouseFeed("acme"),
      },
      new Gauge(),
    );

    const { skipped, warnings, companies } = await discover({
      fetcher,
      renderer,
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      delayMs: 0,
      settings: { getSetting: () => undefined },
      sources: [new AirtableSource()],
    });

    // The LinkedIn company is never rendered; the real company site still is.
    expect(rendered).toContain("https://initech.com/careers");
    expect(rendered).not.toContain("https://www.linkedin.com/company/bigco/jobs/");
    // It's surfaced for manual review and noted in a summary warning, but still counted as a company.
    expect(skipped.map((c) => c.company)).toEqual(["BigCo"]);
    expect(companies.map((c) => c.company)).toContain("BigCo");
    expect(warnings.some((w) => w.message.includes("Skipped 1"))).toBe(true);
  });

  it("merges tracked companies with the Airtable directory, de-duplicating by URL", async () => {
    const gauge = new Gauge();
    const reader = new FakeSharedViewReader(
      airtableData([{ name: "Acme", url: "https://boards.greenhouse.io/acme" }]),
    );
    const fetcher = new GaugedFetcher(
      {
        "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": greenhouseFeed("acme"),
        "https://boards-api.greenhouse.io/v1/boards/zeta/jobs?content=true": greenhouseFeed("zeta"),
      },
      gauge,
    );
    const renderer = new GaugedRenderer("", "", gauge);

    const { postings } = await discover({
      fetcher,
      renderer,
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      trackedCompanies: [
        { careersUrl: "https://boards.greenhouse.io/zeta", name: "Zeta" },
        // Duplicate of the Airtable lead (trailing slash) — must not double-fetch.
        { careersUrl: "https://boards.greenhouse.io/acme/" },
      ],
      delayMs: 0,
      settings: { getSetting: () => undefined },
      sources: [new AirtableSource()],
    });

    expect(postings.map((p) => p.title).sort()).toEqual(["Engineer at acme", "Engineer at zeta"]);
  });

  it("degrades to tracked-only with a warning when the Airtable read fails", async () => {
    const reader = new FakeSharedViewReader(new Error("airtable offline"));
    const fetcher = new GaugedFetcher(
      {
        "https://boards-api.greenhouse.io/v1/boards/zeta/jobs?content=true": greenhouseFeed("zeta"),
      },
      new Gauge(),
    );
    const renderer = new GaugedRenderer("", "", new Gauge());

    const { postings, warnings } = await discover({
      fetcher,
      renderer,
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      trackedCompanies: [{ careersUrl: "https://boards.greenhouse.io/zeta", name: "Zeta" }],
      delayMs: 0,
      settings: { getSetting: () => undefined },
      sources: [new AirtableSource()],
    });

    expect(postings.map((p) => p.title)).toEqual(["Engineer at zeta"]);
    expect(warnings.some((w) => w.source === "airtable" && w.message.includes("offline"))).toBe(
      true,
    );
  });

  it("records a warning when a connector feed fails, keeping other postings", async () => {
    const gauge = new Gauge();
    const reader = new FakeSharedViewReader(
      airtableData([
        { name: "Acme", url: "https://boards.greenhouse.io/acme" },
        { name: "Failco", url: "https://boards.greenhouse.io/failco" },
      ]),
    );
    const fetcher = new GaugedFetcher(
      {
        "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": greenhouseFeed("acme"),
      },
      gauge,
    );
    const renderer = new GaugedRenderer("", "", gauge);

    const { postings, warnings } = await discover({
      fetcher,
      renderer,
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      delayMs: 0,
      settings: { getSetting: () => undefined },
      sources: [new AirtableSource()],
    });
    expect(postings.map((p) => p.title)).toEqual(["Engineer at acme"]);
    expect(warnings.some((w) => w.source === "Failco")).toBe(true);
  });

  it("emits progress events: directory read, lead count, and one per company", async () => {
    const reader = new FakeSharedViewReader(
      airtableData([
        { name: "Acme", url: "https://boards.greenhouse.io/acme" },
        { name: "Globex", url: "https://boards.greenhouse.io/globex" },
      ]),
    );
    const fetcher = new GaugedFetcher(
      {
        "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": greenhouseFeed("acme"),
        "https://boards-api.greenhouse.io/v1/boards/globex/jobs?content=true":
          greenhouseFeed("globex"),
      },
      new Gauge(),
    );

    const events: ScanProgressEvent[] = [];
    await discover({
      fetcher,
      renderer: new GaugedRenderer("", "", new Gauge()),
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      delayMs: 0,
      onProgress: (e) => events.push(e),
      settings: { getSetting: () => undefined },
      sources: [new AirtableSource()],
    });

    expect(events[0]).toEqual({ kind: "directory" });
    expect(events.find((e) => e.kind === "leads")).toEqual({ kind: "leads", total: 2 });
    const companyEvents = events.filter((e) => e.kind === "company");
    expect(companyEvents).toHaveLength(2);
    // Each company event carries a 1-based index and the correct total.
    expect(companyEvents.map((e) => (e.kind === "company" ? e.index : 0)).sort()).toEqual([1, 2]);
  });

  it("floors concurrency at 1 instead of crashing on 0", async () => {
    const gauge = new Gauge();
    const reader = new FakeSharedViewReader(
      airtableData([
        { name: "Acme", url: "https://boards.greenhouse.io/acme" },
        { name: "Globex", url: "https://boards.greenhouse.io/globex" },
      ]),
    );
    const fetcher = new GaugedFetcher(
      {
        "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": greenhouseFeed("acme"),
        "https://boards-api.greenhouse.io/v1/boards/globex/jobs?content=true":
          greenhouseFeed("globex"),
      },
      gauge,
    );
    const renderer = new GaugedRenderer("", "", gauge);

    const { postings } = await discover({
      fetcher,
      renderer,
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      concurrency: 0,
      delayMs: 0,
      settings: { getSetting: () => undefined },
      sources: [new AirtableSource()],
    });
    expect(postings.length).toBeGreaterThan(0);
    expect(gauge.max).toBe(1);
  });
});

/** Minimal deps for the fan-out tests — no real network/browser needed. */
function baseDeps() {
  const fetcher: Fetcher = {
    async fetch(url) {
      return { statusCode: 404, finalUrl: url, bodyText: "" };
    },
  };
  const renderer: PageRenderer = {
    async render() {
      return "";
    },
  };
  return {
    fetcher,
    renderer,
    sharedViewReader: new FakeSharedViewReader({}),
    shareUrl: "",
    settings: { getSetting: () => undefined as string | undefined },
  };
}

/** A source returning fixed leads (and optional warnings), for fan-out tests. */
function staticSource(name: string, leads: { company: string; careersUrl: string }[]): LeadSource {
  return {
    name,
    fetch: async () => ({
      leads: leads.map((l) => ({ ...l, categories: [] })),
      warnings: [],
    }),
  };
}

describe("collectLeads fan-out", () => {
  it("merges leads from all sources and dedups by normalized careers URL (first wins)", async () => {
    const a = staticSource("a", [{ company: "Acme-A", careersUrl: "https://x.test/acme" }]);
    const b = staticSource("b", [
      { company: "Acme-B", careersUrl: "https://x.test/acme/" }, // same URL, trailing slash
      { company: "Globex", careersUrl: "https://x.test/globex" },
    ]);

    const result = await discover({
      ...baseDeps(),
      sources: [a, b],
      trackedCompanies: [],
    });

    const urls = result.companies.map((c) => c.careersUrl);
    expect(urls).toContain("https://x.test/acme"); // a's lead wins the collision
    expect(urls).not.toContain("https://x.test/acme/");
    expect(result.companies.find((c) => c.careersUrl === "https://x.test/acme")?.company).toBe(
      "Acme-A",
    );
    expect(urls).toContain("https://x.test/globex");
  });

  it("a failing source contributes a warning but does not abort the others", async () => {
    const ok = staticSource("ok", [{ company: "Globex", careersUrl: "https://x.test/globex" }]);
    const bad: LeadSource = {
      name: "bad",
      fetch: async () => ({ leads: [], warnings: [{ source: "bad", message: "boom" }] }),
    };

    const result = await discover({ ...baseDeps(), sources: [bad, ok], trackedCompanies: [] });

    expect(result.companies.map((c) => c.careersUrl)).toContain("https://x.test/globex");
    expect(result.warnings.some((w) => w.source === "bad" && w.message === "boom")).toBe(true);
  });

  it("a source that throws degrades to a warning without aborting discovery", async () => {
    const throwing: LeadSource = {
      name: "throwing",
      fetch: async () => {
        throw new Error("kaboom");
      },
    };
    const ok = staticSource("ok", [{ company: "Globex", careersUrl: "https://x.test/globex" }]);

    const result = await discover({
      ...baseDeps(),
      sources: [throwing, ok],
      trackedCompanies: [],
    });

    // The good source's lead still arrives; the throwing source becomes a warning, not a crash.
    expect(result.companies.map((c) => c.careersUrl)).toContain("https://x.test/globex");
    expect(
      result.warnings.some((w) => w.source === "throwing" && w.message.includes("kaboom")),
    ).toBe(true);
  });
});

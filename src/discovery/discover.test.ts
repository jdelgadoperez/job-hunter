import { normalizeCareersUrl } from "@app/domain/normalize";
import type { ScanProgressEvent } from "@app/domain/scan-progress";
import type { Fetcher, FetchResponse } from "@app/net/fetcher";
import { describe, expect, it } from "vitest";
import { makeCompanyId } from "./company-id";
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

  it("stamps each posting with its company's companyId", async () => {
    const reader = new FakeSharedViewReader(
      airtableData([{ name: "Acme", url: "https://boards.greenhouse.io/acme" }]),
    );
    const fetcher = new GaugedFetcher(
      {
        "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": greenhouseFeed("acme"),
      },
      new Gauge(),
    );

    const { postings } = await discover({
      fetcher,
      renderer: new GaugedRenderer("", "", new Gauge()),
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      delayMs: 0,
      settings: { getSetting: () => undefined },
      sources: [new AirtableSource()],
    });

    const posting = postings[0];
    expect(posting?.companyId).toBe(makeCompanyId("https://boards.greenhouse.io/acme"));
  });

  it("disposes the renderer once after the run, even when a render throws", async () => {
    let disposeCount = 0;
    const renderer: PageRenderer = {
      async render(url) {
        if (url === "https://boom.com/careers") throw new Error("render crashed");
        return JSONLD_HTML;
      },
      async dispose() {
        disposeCount += 1;
      },
    };
    const reader = new FakeSharedViewReader(
      airtableData([
        { name: "Initech", url: "https://initech.com/careers" },
        { name: "Boom", url: "https://boom.com/careers" },
      ]),
    );

    await discover({
      fetcher: new GaugedFetcher({}, new Gauge()),
      renderer,
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      delayMs: 0,
      settings: { getSetting: () => undefined },
      sources: [new AirtableSource()],
    });

    expect(disposeCount).toBe(1);
  });

  it("degrades a failing browser teardown to a warning without aborting the run", async () => {
    const renderer: PageRenderer = {
      async render() {
        return JSONLD_HTML;
      },
      async dispose() {
        throw new Error("browser stuck");
      },
    };
    const reader = new FakeSharedViewReader(
      airtableData([{ name: "Initech", url: "https://initech.com/careers" }]),
    );

    const { postings, warnings } = await discover({
      fetcher: new GaugedFetcher({}, new Gauge()),
      renderer,
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      delayMs: 0,
      settings: { getSetting: () => undefined },
      sources: [new AirtableSource()],
    });

    // The crawled posting still comes through despite the teardown failure...
    expect(postings.map((p) => p.title)).toEqual(["Operations Lead"]);
    // ...and the failure surfaces as a warning rather than crashing discover.
    expect(warnings.some((w) => w.message.includes("Browser cleanup"))).toBe(true);
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

  it("skips directory leads in skipCareersUrls but keeps tracked companies", async () => {
    const gauge = new Gauge();
    // The directory URL for Fresh Co carries a trailing slash and mixed case; the skip-set entry
    // below is a plain string literal in already-normalized form. The two are byte-distinct but
    // must normalize equal, so the membership check only matches if it actually normalizes the
    // lead's URL before comparing (a raw `skip.has(lead.careersUrl)` check would miss this and
    // fail to skip Fresh Co).
    const reader = new FakeSharedViewReader(
      airtableData([
        { name: "Fresh Co", url: "https://Fresh.co/careers/" },
        { name: "Stale Co", url: "https://stale.co/careers" },
      ]),
    );

    const { companies } = await discover({
      fetcher: new GaugedFetcher({}, gauge),
      renderer: new GaugedRenderer("", "", gauge),
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      trackedCompanies: [{ careersUrl: "https://tracked.co/careers", name: "Tracked Co" }],
      skipCareersUrls: new Set(["https://fresh.co/careers"]),
      concurrency: 2,
      delayMs: 0,
      settings: { getSetting: () => undefined },
      sources: [new AirtableSource()],
    });

    const crawledUrls = new Set(companies.map((c) => normalizeCareersUrl(c.careersUrl)));
    expect(crawledUrls.has(normalizeCareersUrl("https://stale.co/careers"))).toBe(true);
    expect(crawledUrls.has(normalizeCareersUrl("https://tracked.co/careers"))).toBe(true);
    expect(crawledUrls.has(normalizeCareersUrl("https://Fresh.co/careers/"))).toBe(false);
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

describe("discover retry pass", () => {
  it("retries a company that failed the main pass, and it succeeds this time", async () => {
    let renderCalls = 0;
    const renderer: PageRenderer = {
      async render(url) {
        if (url === "https://boom.com/careers") {
          renderCalls += 1;
          if (renderCalls === 1) throw new Error("render crashed");
          return JSONLD_HTML;
        }
        return JSONLD_HTML;
      },
    };
    const reader = new FakeSharedViewReader(
      airtableData([{ name: "Boom", url: "https://boom.com/careers" }]),
    );

    const { postings, warnings } = await discover({
      fetcher: new GaugedFetcher({}, new Gauge()),
      renderer,
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      delayMs: 0,
      settings: { getSetting: () => undefined },
      sources: [new AirtableSource()],
    });

    // Failed once, succeeded on retry — no warning, and the posting made it through.
    expect(renderCalls).toBe(2);
    expect(warnings).toHaveLength(0);
    expect(postings.map((p) => p.title)).toEqual(["Operations Lead"]);
  });

  it("keeps a per-company warning (with careersUrl) when a company fails both the main pass and the retry", async () => {
    const renderer: PageRenderer = {
      async render(url) {
        if (url === "https://boom.com/careers") throw new Error("render crashed");
        return JSONLD_HTML;
      },
    };
    const reader = new FakeSharedViewReader(
      airtableData([
        { name: "Boom", url: "https://boom.com/careers" },
        { name: "Initech", url: "https://initech.com/careers" },
      ]),
    );

    const { postings, warnings } = await discover({
      fetcher: new GaugedFetcher({}, new Gauge()),
      renderer,
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      delayMs: 0,
      settings: { getSetting: () => undefined },
      sources: [new AirtableSource()],
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.source).toBe("Boom");
    expect(warnings[0]?.careersUrl).toBe("https://boom.com/careers");
    // The other company's posting still comes through despite Boom's persistent failure.
    expect(postings.map((p) => p.title)).toEqual(["Operations Lead"]);
  });

  it("does not retry source-level failures or the unscrapable-host skip notice", async () => {
    const bad: LeadSource = {
      name: "bad-source",
      fetch: async () => ({ leads: [], warnings: [{ source: "bad-source", message: "boom" }] }),
    };
    const rendered: string[] = [];
    const renderer: PageRenderer = {
      async render(url) {
        rendered.push(url);
        return JSONLD_HTML;
      },
    };
    const reader = new FakeSharedViewReader(
      airtableData([
        { name: "BigCo", url: "https://www.linkedin.com/company/bigco/jobs/" },
        { name: "Initech", url: "https://initech.com/careers" },
      ]),
    );

    const { warnings } = await discover({
      fetcher: new GaugedFetcher({}, new Gauge()),
      renderer,
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      delayMs: 0,
      settings: { getSetting: () => undefined },
      sources: [bad, new AirtableSource()],
    });

    // Source-level failure has no careersUrl — never retried.
    const sourceWarning = warnings.find((w) => w.source === "bad-source");
    expect(sourceWarning?.careersUrl).toBeUndefined();
    // The unscrapable-host summary warning also has no careersUrl.
    const skipWarning = warnings.find((w) => w.source === "directory");
    expect(skipWarning?.careersUrl).toBeUndefined();
    // LinkedIn is never rendered (skip, not a failure) — only Initech's careers page renders once.
    expect(rendered).toEqual(["https://initech.com/careers"]);
  });

  it("bounds concurrency in the retry pass", async () => {
    const companies = Array.from({ length: 6 }, (_, i) => ({
      name: `Company${i}`,
      url: `https://company${i}.example.com/careers`,
    }));
    const attempts = new Map<string, number>();
    let inFlight = 0;
    let peak = 0;
    const renderer: PageRenderer = {
      async render(url) {
        const attempt = (attempts.get(url) ?? 0) + 1;
        attempts.set(url, attempt);
        // First attempt (main pass) fails immediately, forcing every lead into the retry pass.
        if (attempt === 1) throw new Error("render crashed");
        // Second attempt (retry pass) is observed for concurrency.
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          await sleep(5);
          return JSONLD_HTML;
        } finally {
          inFlight -= 1;
        }
      },
    };
    const reader = new FakeSharedViewReader(airtableData(companies));

    const { warnings } = await discover({
      fetcher: new GaugedFetcher({}, new Gauge()),
      renderer,
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      concurrency: 2,
      delayMs: 0,
      settings: { getSetting: () => undefined },
      sources: [new AirtableSource()],
    });

    // All six leads failed the main pass and succeeded on retry — no warnings left over.
    expect(warnings).toHaveLength(0);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("skips the retry pass for a company in skipRetryFor, but still attempts it on the main pass", async () => {
    let renderCalls = 0;
    const renderer: PageRenderer = {
      async render(url) {
        if (url === "https://boom.com/careers") {
          renderCalls += 1;
          throw new Error("render crashed");
        }
        return JSONLD_HTML;
      },
    };
    const reader = new FakeSharedViewReader(
      airtableData([{ name: "Boom", url: "https://boom.com/careers" }]),
    );

    const { warnings } = await discover({
      fetcher: new GaugedFetcher({}, new Gauge()),
      renderer,
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      delayMs: 0,
      settings: { getSetting: () => undefined },
      sources: [new AirtableSource()],
      skipRetryFor: new Set(["https://boom.com/careers"]),
    });

    // Attempted once (main pass) — the retry pass skipped it, so renderCalls stops at 1.
    expect(renderCalls).toBe(1);
    expect(warnings[0]?.careersUrl).toBe("https://boom.com/careers");
  });
});

describe("discover time budget", () => {
  it("stops crawling once the wall-clock budget is exhausted, returning partial results", async () => {
    let clockMs = 0;
    const companies = Array.from({ length: 5 }, (_, i) => ({
      name: `Co${i}`,
      url: `https://boards.greenhouse.io/co${i}`,
    }));
    const routes: Record<string, string> = {};
    for (const c of companies) {
      const token = c.url.split("/").pop() as string;
      routes[`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`] =
        greenhouseFeed(token);
    }
    // Every board fetch burns 10s of the budget; serial (concurrency 1) so the cutoff is deterministic.
    const fetcher: Fetcher = {
      async fetch(url) {
        clockMs += 10_000;
        const body = routes[url];
        return body === undefined
          ? { statusCode: 404, finalUrl: url, bodyText: "" }
          : { statusCode: 200, finalUrl: url, bodyText: body };
      },
    };
    const reader = new FakeSharedViewReader(airtableData(companies));

    const events: ScanProgressEvent[] = [];
    const {
      postings,
      warnings,
      truncated,
      companies: crawled,
    } = await discover({
      fetcher,
      renderer: new GaugedRenderer("", "", new Gauge()),
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      concurrency: 1,
      delayMs: 0,
      budgetMs: 25_000,
      now: () => clockMs,
      onProgress: (e) => events.push(e),
      settings: { getSetting: () => undefined },
      sources: [new AirtableSource()],
    });

    // Budget 25s, 10s per fetch: the first three companies crawl, the rest are skipped.
    expect(truncated).toBe(true);
    expect(postings).toHaveLength(3);
    // Every lead still appears in the directory snapshot, so the removed-diff is unaffected...
    expect(crawled).toHaveLength(5);
    // ...but only the crawled companies emit a progress event.
    expect(events.filter((e) => e.kind === "company")).toHaveLength(3);
    expect(warnings.some((w) => w.source === "directory" && w.message.includes("3/5"))).toBe(true);
  });

  it("does not truncate (and keeps retrying) when no budget is set", async () => {
    const reader = new FakeSharedViewReader(
      airtableData([{ name: "Acme", url: "https://boards.greenhouse.io/acme" }]),
    );
    const fetcher = new GaugedFetcher(
      {
        "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": greenhouseFeed("acme"),
      },
      new Gauge(),
    );

    const { truncated } = await discover({
      fetcher,
      renderer: new GaugedRenderer("", "", new Gauge()),
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      delayMs: 0,
      settings: { getSetting: () => undefined },
      sources: [new AirtableSource()],
    });

    expect(truncated).toBe(false);
  });

  it("does not burn the inter-request delay on leads skipped after the budget is spent", async () => {
    // Regression: waitTurn() used to be awaited for every lead BEFORE the budget was checked, so with
    // a non-zero delayMs the crawl kept sleeping delayMs per remaining lead even after the budget was
    // exhausted — eroding the safety margin against the runner's hard timeout. With the fix, an
    // over-budget lead returns immediately without chaining a sleep.
    let clockMs = 0;
    const leadCount = 40;
    const delayMs = 50;
    const companies = Array.from({ length: leadCount }, (_, i) => ({
      name: `Co${i}`,
      url: `https://boards.greenhouse.io/co${i}`,
    }));
    const routes: Record<string, string> = {};
    for (const c of companies) {
      const token = c.url.split("/").pop() as string;
      routes[`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`] =
        greenhouseFeed(token);
    }
    // The very first board fetch spends the whole budget, so leads 2..40 are all over-budget.
    const fetcher: Fetcher = {
      async fetch(url) {
        clockMs += 30_000;
        const body = routes[url];
        return body === undefined
          ? { statusCode: 404, finalUrl: url, bodyText: "" }
          : { statusCode: 200, finalUrl: url, bodyText: body };
      },
    };
    const reader = new FakeSharedViewReader(airtableData(companies));

    const startedAt = Date.now();
    const { truncated, postings } = await discover({
      fetcher,
      renderer: new GaugedRenderer("", "", new Gauge()),
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      concurrency: 1,
      delayMs,
      budgetMs: 25_000,
      now: () => clockMs,
      settings: { getSetting: () => undefined },
      sources: [new AirtableSource()],
    });
    const elapsedMs = Date.now() - startedAt;

    expect(truncated).toBe(true);
    expect(postings).toHaveLength(1);
    // The buggy code would sleep ~delayMs × (leadCount − 1) ≈ 1950ms on the skipped leads; the fix
    // skips the sleep entirely. A generous bound proves the delay is no longer accumulated per lead.
    expect(elapsedMs).toBeLessThan(delayMs * (leadCount - 1));
  });

  it("skips the retry pass for a lead that failed once the budget is exhausted", async () => {
    let clockMs = 0;
    let renderCalls = 0;
    const renderer: PageRenderer = {
      async render() {
        renderCalls += 1;
        clockMs += 30_000; // a single render blows the whole budget
        throw new Error("render crashed");
      },
    };
    const reader = new FakeSharedViewReader(
      airtableData([{ name: "Boom", url: "https://boom.com/careers" }]),
    );

    const { warnings } = await discover({
      fetcher: new GaugedFetcher({}, new Gauge()),
      renderer,
      sharedViewReader: reader,
      shareUrl: SHARE_URL,
      delayMs: 0,
      budgetMs: 25_000,
      now: () => clockMs,
      settings: { getSetting: () => undefined },
      sources: [new AirtableSource()],
    });

    // Rendered once on the main pass; the retry pass is skipped because the budget is spent.
    expect(renderCalls).toBe(1);
    // The failure still surfaces as a warning (kept, not retried).
    expect(warnings.some((w) => w.source === "Boom")).toBe(true);
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

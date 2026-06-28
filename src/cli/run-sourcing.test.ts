import type { PageRenderer } from "@app/discovery/connectors/browser";
import { FakePostingFeed } from "@app/discovery/feed/posting-feed";
import type { ScanStore } from "@app/discovery/scan-store";
import { FakeSharedViewReader } from "@app/discovery/sources/airtable";
import { AirtableSource } from "@app/discovery/sources/airtable-source";
import type { JobPosting } from "@app/domain/types";
import type { FetchResponse, Fetcher } from "@app/net/fetcher";
import type { CompanyRef, Repository } from "@app/storage/repository";
import { describe, expect, it } from "vitest";
import { runSourcing } from "./commands";

class RouteFetcher implements Fetcher {
  constructor(private readonly routes: Record<string, string>) {}
  async fetch(url: string): Promise<FetchResponse> {
    const body = this.routes[url];
    return body === undefined
      ? { statusCode: 404, finalUrl: url, bodyText: "" }
      : { statusCode: 200, finalUrl: url, bodyText: body };
  }
}

class NullRenderer implements PageRenderer {
  async render(): Promise<string> {
    return "";
  }
}

function airtableData(companies: { name: string; url: string }[]): unknown {
  return {
    data: {
      table: {
        columns: [
          { id: "c1", name: "Company" },
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

/** A ScanStore with no real DB — captures what sourcing writes. Crucially has NO saveMatchResult. */
function fakeStore(): {
  store: ScanStore;
  saved: JobPosting[];
  finished: { postingsSeen: number; companiesSeen: number }[];
} {
  const saved: JobPosting[] = [];
  const finished: { postingsSeen: number; companiesSeen: number }[] = [];
  const store: ScanStore = {
    startScan: () => 1,
    recordDirectory: (_id: number, _companies: CompanyRef[]) => ({
      newCompanies: [],
      removedCompanies: [],
    }),
    savePosting: (posting) => {
      saved.push(posting);
    },
    listLivePostingsNotSeen: () => [],
    markPostingExpired: () => false,
    expireStalePostings: () => 0,
    finishScan: (_id, summary) => {
      finished.push({ postingsSeen: summary.postingsSeen, companiesSeen: summary.companiesSeen });
    },
  };
  return { store, saved, finished };
}

function discoverDeps(routes: Record<string, string>, companies: { name: string; url: string }[]) {
  return {
    fetcher: new RouteFetcher(routes),
    renderer: new NullRenderer(),
    sharedViewReader: new FakeSharedViewReader(airtableData(companies)),
    shareUrl: "https://airtable.com/appX/shrX/tblX",
    delayMs: 0,
    settings: { getSetting: () => undefined },
    sources: [new AirtableSource()],
  };
}

describe("runSourcing", () => {
  it("persists discovered postings and records the directory, writing no match results", async () => {
    const greenhouse = JSON.stringify({
      jobs: [
        {
          title: "Senior TypeScript Engineer",
          absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
          content: "TypeScript and React.",
          location: { name: "Remote" },
        },
      ],
    });
    const { store, saved, finished } = fakeStore();

    const outcome = await runSourcing({
      repo: store,
      discoverDeps: discoverDeps(
        {
          "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": greenhouse,
        },
        [{ name: "Acme", url: "https://boards.greenhouse.io/acme" }],
      ),
    });

    // Sourcing returns and persists exactly the discovered postings...
    expect(outcome.postings).toHaveLength(1);
    expect(saved.map((p) => p.id)).toEqual(outcome.postings.map((p) => p.id));
    // ...records the scan's seen counts...
    expect(finished).toEqual([{ postingsSeen: 1, companiesSeen: 1 }]);
    // ...and the fake store — which has NO saveMatchResult — is a complete dependency, proving
    // sourcing never scores. (If it scored, this would not typecheck / would throw.)
    expect(outcome.expired).toBe(0);
  });

  it("hybrid remote mode merges the feed with a local crawl of tracked companies only", async () => {
    const feedPosting: JobPosting = {
      id: "feed:1",
      company: "FeedCo",
      title: "Remote Platform Engineer",
      url: "https://example.test/feed/1",
      source: "greenhouse",
      description: "from the shared feed",
      fetchedAt: new Date("2026-06-26T00:00:00Z"),
    };
    const feed = new FakePostingFeed({ postings: [feedPosting], warnings: [] });
    const greenhouse = JSON.stringify({
      jobs: [
        {
          title: "Backend Engineer",
          absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
          content: "TypeScript and React.",
        },
      ],
    });
    const { store, saved } = fakeStore();

    const outcome = await runSourcing({
      repo: store,
      feed,
      discoverDeps: {
        fetcher: new RouteFetcher({
          "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": greenhouse,
        }),
        renderer: new NullRenderer(),
        // Not consulted in remote mode (sources is forced to [] so only tracked companies crawl).
        sharedViewReader: new FakeSharedViewReader({}),
        shareUrl: "",
        settings: { getSetting: () => undefined },
        trackedCompanies: [{ careersUrl: "https://boards.greenhouse.io/acme", name: "Acme" }],
        delayMs: 0,
      },
    });

    // Feed posting + the one tracked-company crawl posting, merged and persisted.
    expect(outcome.postings.map((p) => p.id)).toContain("feed:1");
    expect(outcome.postings).toHaveLength(2);
    expect(saved.map((p) => p.id).sort()).toEqual(outcome.postings.map((p) => p.id).sort());
    // The companies snapshot is just the tracked company — the shared directory is the cloud's job.
    expect(outcome.companies.map((c) => c.careersUrl)).toEqual([
      "https://boards.greenhouse.io/acme",
    ]);
  });
});

// Compile-time guarantee: the production SQLite Repository satisfies the ScanStore seam, so the same
// runSourcing drives both it and the future Postgres store. (Type-only — never constructed here.)
type _RepositoryIsAScanStore = Repository extends ScanStore ? true : never;
const _assertRepositorySatisfiesScanStore: _RepositoryIsAScanStore = true;
void _assertRepositorySatisfiesScanStore;

import type { PageRenderer } from "@app/discovery/connectors/browser";
import type { ScanStore } from "@app/discovery/scan-store";
import { FakeSharedViewReader } from "@app/discovery/sources/airtable";
import { AirtableSource } from "@app/discovery/sources/airtable-source";
import type { JobPosting } from "@app/domain/types";
import type { FetchResponse, Fetcher } from "@app/net/fetcher";
import type { CompanyRef } from "@app/storage/repository";
import { describe, expect, it } from "vitest";
import { runScannerOnce } from "./run-once";

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

/** A ScanStore with no real DB. Has NO saveMatchResult — proving the worker never scores. */
function fakeStore(): { store: ScanStore; saved: JobPosting[] } {
  const saved: JobPosting[] = [];
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
    finishScan: () => {},
  };
  return { store, saved };
}

describe("runScannerOnce", () => {
  it("crawls the shared sources (full crawl) and writes postings to the store, without scoring", async () => {
    const greenhouse = JSON.stringify({
      jobs: [
        {
          title: "Senior TypeScript Engineer",
          absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
          content: "TypeScript and React.",
        },
      ],
    });
    const { store, saved } = fakeStore();

    const outcome = await runScannerOnce({
      store,
      discoverDeps: {
        fetcher: new RouteFetcher({
          "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": greenhouse,
        }),
        renderer: new NullRenderer(),
        sharedViewReader: new FakeSharedViewReader(
          airtableData([{ name: "Acme", url: "https://boards.greenhouse.io/acme" }]),
        ),
        shareUrl: "https://airtable.com/appX/shrX/tblX",
        delayMs: 0,
        settings: { getSetting: () => undefined },
        sources: [new AirtableSource()],
      },
    });

    expect(outcome.postings).toHaveLength(1);
    expect(saved.map((p) => p.id)).toEqual(outcome.postings.map((p) => p.id));
  });
});

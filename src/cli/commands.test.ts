import type { PageRenderer } from "@app/discovery/connectors/browser";
import { FakeSharedViewReader } from "@app/discovery/sources/airtable";
import type { SkillProfile } from "@app/domain/types";
import { HeuristicScorer } from "@app/matching/heuristic-scorer";
import type { FetchResponse, Fetcher } from "@app/net/fetcher";
import { Repository } from "@app/storage/repository";
import { describe, expect, it } from "vitest";
import { listMatches, runProfile, runScan, trackAdd, trackList, trackRemove } from "./commands";

function newRepo(): Repository {
  return new Repository(":memory:");
}

function capture(): { log: (m: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (m) => lines.push(m), lines };
}

const profile: SkillProfile = {
  skills: ["typescript", "react"],
  roleKeywords: ["engineer"],
  categories: [],
};

class NullRenderer implements PageRenderer {
  async render(): Promise<string> {
    return "";
  }
}

class RouteFetcher implements Fetcher {
  constructor(private readonly routes: Record<string, string>) {}
  async fetch(url: string): Promise<FetchResponse> {
    const body = this.routes[url];
    return body === undefined
      ? { statusCode: 404, finalUrl: url, bodyText: "" }
      : { statusCode: 200, finalUrl: url, bodyText: body };
  }
}

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

describe("track commands", () => {
  it("adds, lists, and removes", () => {
    const repo = newRepo();
    const out = capture();
    trackAdd(repo, "https://acme.com/careers", "Acme", out.log);
    trackList(repo, out.log);
    trackRemove(repo, "https://acme.com/careers", out.log);
    trackList(repo, out.log);
    expect(out.lines[0]).toContain("Tracking Acme");
    expect(out.lines[1]).toContain("https://acme.com/careers");
    expect(out.lines[2]).toContain("Removed");
    expect(out.lines[3]).toContain("No tracked companies");
    repo.close();
  });
});

describe("runProfile", () => {
  it("builds and saves a profile from resume text", async () => {
    const repo = newRepo();
    const out = capture();
    const built = await runProfile(
      { repo, readResume: async () => "Experienced with TypeScript and React." },
      "/tmp/cv.txt",
      out.log,
    );
    expect(Array.isArray(built.skills)).toBe(true);
    expect(repo.getLatestProfile()).toEqual(built);
    expect(out.lines[0]).toContain("Saved profile");
    repo.close();
  });
});

describe("runScan + listMatches", () => {
  it("discovers, scores, stores, and lists matches", async () => {
    const repo = newRepo();
    const out = capture();
    const greenhouse = JSON.stringify({
      jobs: [
        {
          title: "Senior TypeScript Engineer",
          absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
          content: "We need TypeScript and React.",
          location: { name: "Remote" },
        },
      ],
    });

    const result = await runScan(
      {
        repo,
        profile,
        scorer: new HeuristicScorer(),
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
        },
      },
      out.log,
    );

    expect(result.count).toBe(1);
    expect(out.lines[0]).toContain("Scanned and scored 1");

    const listOut = capture();
    listMatches(repo, 0, listOut.log);
    expect(listOut.lines[0]).toContain("Senior TypeScript Engineer");
    expect(listOut.lines[0]).toContain("boards.greenhouse.io/acme");
    repo.close();
  });

  it("reports an empty list before any scan", () => {
    const repo = newRepo();
    const out = capture();
    listMatches(repo, 0, out.log);
    expect(out.lines[0]).toContain("No matches yet");
    repo.close();
  });
});

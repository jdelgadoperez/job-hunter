import type { PageRenderer } from "@app/discovery/connectors/browser";
import { FakeSharedViewReader } from "@app/discovery/sources/airtable";
import { AirtableSource } from "@app/discovery/sources/airtable-source";
import type { JobPosting, MatchResult, Scorer, SkillProfile } from "@app/domain/types";
import { HeuristicScorer } from "@app/matching/heuristic-scorer";
import type { ScoreOutcome } from "@app/matching/score-run";
import type { FetchResponse, Fetcher } from "@app/net/fetcher";
import { Repository } from "@app/storage/repository";
import { describe, expect, it } from "vitest";
import {
  formatScorePlan,
  listMatches,
  runProfile,
  runScan,
  trackAdd,
  trackList,
  trackRemove,
} from "./commands";

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

function outcome(overrides: Partial<ScoreOutcome["counts"]> = {}): ScoreOutcome {
  const counts = {
    inDb: 200,
    afterRemote: 120,
    afterHeuristic: 200,
    afterCap: 100,
    alreadyScoredSkipped: 18,
    triageTitles: 82,
    deepScored: 0,
    ...overrides,
  };
  return {
    counts,
    estimate: {
      triageTitles: counts.triageTitles,
      triageBatches: 3,
      deepScores: counts.triageTitles,
      triageUsd: 0.16,
      deepScoreUsd: 2.46,
      totalUsd: 2.62,
    },
    warnings: [],
    abortedOnLimit: false,
  };
}

describe("formatScorePlan", () => {
  it("shows the db total, cap, skipped count, and estimated total for a dry run", () => {
    const result = outcome();
    const text = formatScorePlan(result, { remoteOnly: true, limit: 100, dryRun: true });
    expect(text).toContain(String(result.counts.inDb));
    expect(text).toContain("100");
    expect(text).toContain("18");
    expect(text).toContain("2.62");
  });

  it("reports how many were deep-scored after a real run", () => {
    const text = formatScorePlan(outcome({ deepScored: 80 }), {
      remoteOnly: false,
      limit: 100,
      dryRun: false,
    });
    expect(text).toContain("80");
  });
});

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
          settings: { getSetting: () => undefined },
          sources: [new AirtableSource()],
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

  it("scores every posting concurrently, within a bounded cap", async () => {
    const repo = newRepo();
    // A scorer that records how many calls are in flight at once.
    class ProbeScorer implements Scorer {
      inFlight = 0;
      maxInFlight = 0;
      scored: string[] = [];
      async score(_profile: SkillProfile, posting: JobPosting): Promise<MatchResult> {
        this.inFlight += 1;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        await new Promise((r) => setTimeout(r, 2));
        this.inFlight -= 1;
        this.scored.push(posting.id);
        return { score: 60, matchedSkills: [], missingSkills: [] };
      }
    }
    const scorer = new ProbeScorer();
    const jobs = Array.from({ length: 8 }, (_, i) => ({
      title: `Engineer ${i}`,
      absolute_url: `https://boards.greenhouse.io/acme/jobs/${i}`,
      content: "TypeScript and React.",
    }));

    const result = await runScan(
      {
        repo,
        profile,
        scorer,
        discoverDeps: {
          fetcher: new RouteFetcher({
            "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": JSON.stringify({
              jobs,
            }),
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
      },
      capture().log,
    );

    expect(result.count).toBe(8);
    expect(scorer.scored).toHaveLength(8); // every posting scored
    expect(repo.listScoredPostings(0)).toHaveLength(8); // and stored
    expect(scorer.maxInFlight).toBeGreaterThan(1); // actually concurrent
    expect(scorer.maxInFlight).toBeLessThanOrEqual(4); // but capped
    repo.close();
  });

  it("reports an empty list before any scan", () => {
    const repo = newRepo();
    const out = capture();
    listMatches(repo, 0, out.log);
    expect(out.lines[0]).toContain("No matches yet");
    repo.close();
  });

  it("expires a posting via liveness re-check once it's gone from its board", async () => {
    const repo = newRepo();
    const ghUrl = "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true";
    const withJob = JSON.stringify({
      jobs: [
        {
          title: "Senior TypeScript Engineer",
          absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
          content: "TypeScript and React.",
        },
      ],
    });
    const empty = JSON.stringify({ jobs: [] });

    const deps = (companies: { name: string; url: string }[], routes: Record<string, string>) => ({
      repo,
      profile,
      scorer: new HeuristicScorer(),
      discoverDeps: {
        fetcher: new RouteFetcher(routes),
        renderer: new NullRenderer(),
        sharedViewReader: new FakeSharedViewReader(airtableData(companies)),
        shareUrl: "https://airtable.com/appX/shrX/tblX",
        delayMs: 0,
        settings: { getSetting: () => undefined as string | undefined },
        sources: [new AirtableSource()],
      },
    });

    // Scan 1: Acme is listed and its board has the job.
    await runScan(
      deps([{ name: "Acme", url: "https://boards.greenhouse.io/acme" }], { [ghUrl]: withJob }),
      capture().log,
    );
    expect(repo.listScoredPostings(0)).toHaveLength(1);

    // Scan 2: Acme drops from the directory (so it isn't scanned) and its board now lists nothing.
    // The unseen posting is re-checked against its board, found gone, and expired immediately —
    // before the two-consecutive-miss heuristic would have caught it.
    const result = await runScan(deps([], { [ghUrl]: empty }), capture().log);
    expect(result.expired).toBe(1);
    expect(repo.listScoredPostings(0)).toHaveLength(0);
    expect(repo.listScoredPostings(0, { includeExpired: true })).toHaveLength(1);
    repo.close();
  });
});

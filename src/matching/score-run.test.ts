import type { JobPosting, MatchResult, SkillProfile, Warning } from "@app/domain/types";
import type { ScoringCandidate } from "@app/storage/repository";
import { describe, expect, it } from "vitest";
import { LlmTriager } from "./llm-triager";
import { runScoreRun, type ScoreOptions, type ScoreRepo } from "./score-run";
import { FakeTriageClient } from "./triage-client";

const profile: SkillProfile = { skills: ["ts"], roleKeywords: [], categories: [] };

function posting(id: string, title: string, location?: string): JobPosting {
  return {
    id,
    company: "acme",
    title,
    url: `https://example.test/${id}`,
    source: "test",
    description: `${title} description`,
    ...(location ? { location } : {}),
    fetchedAt: new Date("2026-06-26T00:00:00Z"),
  };
}

function candidate(
  id: string,
  title: string,
  heuristicScore: number,
  opts: { location?: string; alreadyLlmScored?: boolean } = {},
): ScoringCandidate {
  return {
    posting: posting(id, title, opts.location),
    heuristicScore,
    alreadyLlmScored: opts.alreadyLlmScored ?? false,
  };
}

/** In-memory ScoreRepo capturing saved results. */
function fakeRepo(candidates: ScoringCandidate[]): {
  repo: ScoreRepo;
  saved: { id: string; result: MatchResult; scorer: "heuristic" | "llm" }[];
} {
  const saved: { id: string; result: MatchResult; scorer: "heuristic" | "llm" }[] = [];
  const repo: ScoreRepo = {
    countLivePostings: () => candidates.length,
    listPostingsForScoring: ({ minHeuristic }) =>
      candidates.filter((c) => c.heuristicScore >= minHeuristic),
    saveMatchResult: (id, result, scorer) => saved.push({ id, result, scorer }),
  };
  return { repo, saved };
}

const baseOptions: ScoreOptions = {
  minHeuristic: 30,
  limit: 100,
  remoteOnly: false,
  rescore: false,
  dryRun: false,
  batchSize: 40,
  cost: { perTriageTitleUsd: 0.002, perDeepScoreUsd: 0.03 },
};

/** A Scorer that returns a fixed score derived from the posting id length (deterministic, no hardcode). */
const deepScorer = {
  score: (_p: SkillProfile, posting: JobPosting): MatchResult => ({
    score: posting.title.length,
    matchedSkills: [],
    missingSkills: [],
    rationale: "deep",
  }),
};

function keepAllTriager(): LlmTriager {
  // FakeTriageClient keeping every id in the batch.
  const client = new FakeTriageClient((request) => ({
    decisions: request.user
      .split("\n")
      .filter((line) => line.includes("id="))
      .map((line) => {
        const id = line.split("id=")[1]?.split(" ")[0] ?? "";
        return { id, keep: true, reason: "keep" };
      }),
  }));
  return new LlmTriager(client, baseOptions.batchSize);
}

describe("runScoreRun", () => {
  it("gates by heuristic floor, caps by limit, and deep-scores survivors", async () => {
    const candidates = [
      candidate("a", "Staff Engineer", 80),
      candidate("b", "Backend Engineer", 45),
      candidate("c", "Sales Rep", 10), // below floor
    ];
    const { repo, saved } = fakeRepo(candidates);

    const outcome = await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, limit: 1 },
    });

    expect(outcome.counts.afterHeuristic).toBe(2);
    expect(outcome.counts.afterCap).toBe(1);
    // Only the top-by-heuristic ("a") is deep-scored, tagged llm.
    expect(saved).toEqual([
      {
        id: "a",
        result: {
          score: "Staff Engineer".length,
          matchedSkills: [],
          missingSkills: [],
          rationale: "deep",
        },
        scorer: "llm",
      },
    ]);
  });

  it("skips already-LLM-scored postings unless rescore is set", async () => {
    const candidates = [candidate("a", "Staff Engineer", 80, { alreadyLlmScored: true })];
    const skip = await runScoreRun({
      repo: fakeRepo(candidates).repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: baseOptions,
    });
    expect(skip.counts.alreadyScoredSkipped).toBe(1);
    expect(skip.counts.deepScored).toBe(0);

    const forced = fakeRepo(candidates);
    const rescore = await runScoreRun({
      repo: forced.repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, rescore: true },
    });
    expect(rescore.counts.deepScored).toBe(1);
    expect(forced.saved.length).toBe(1);
  });

  it("drops non-remote postings when remoteOnly is on (unknown location kept)", async () => {
    const candidates = [
      candidate("remote", "Engineer A", 70, { location: "Remote - US" }),
      candidate("onsite", "Engineer B", 70, { location: "London, UK" }),
      candidate("unknown", "Engineer C", 70),
    ];
    const { repo, saved } = fakeRepo(candidates);

    const outcome = await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, remoteOnly: true },
    });

    expect(outcome.counts.afterRemote).toBe(2);
    expect(saved.map((s) => s.id).sort()).toEqual(["remote", "unknown"]);
  });

  it("dry-run spends nothing: no triage calls, no saves, estimate populated", async () => {
    const candidates = [candidate("a", "Staff Engineer", 80)];
    const { repo, saved } = fakeRepo(candidates);
    // A triager whose client throws — proves dry-run never calls it.
    const throwingTriager = new LlmTriager(
      new FakeTriageClient(new Error("should not be called")),
      40,
    );

    const outcome = await runScoreRun({
      repo,
      profile,
      triager: throwingTriager,
      scorer: deepScorer,
      options: { ...baseOptions, dryRun: true },
    });

    expect(saved).toEqual([]);
    expect(outcome.counts.deepScored).toBe(0);
    expect(outcome.estimate.deepScores).toBe(1);
    expect(outcome.estimate.totalUsd).toBeGreaterThan(0);
  });

  it("aborts when the triager throws a usage-limit error (no deep scoring, no saves)", async () => {
    const candidates = [candidate("a", "Engineer A", 80), candidate("b", "Engineer B", 70)];
    const { repo, saved } = fakeRepo(candidates);
    const warnings: Warning[] = [];
    const usageLimitMessage =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits."}}';
    const triager = new LlmTriager(
      new FakeTriageClient(new Error(usageLimitMessage)),
      baseOptions.batchSize,
    );

    const outcome = await runScoreRun({
      repo,
      profile,
      triager,
      scorer: deepScorer,
      options: baseOptions,
      onWarning: (w) => warnings.push(w),
    });

    expect(outcome.abortedOnLimit).toBe(true);
    expect(outcome.counts.deepScored).toBe(0);
    expect(saved).toEqual([]);
    expect(warnings.some((w) => /usage limit/i.test(w.message))).toBe(true);
  });

  it("aborts deep-scoring on a usage-limit error and reports it", async () => {
    const candidates = [candidate("a", "Engineer A", 80), candidate("b", "Engineer B", 70)];
    const { repo, saved } = fakeRepo(candidates);
    const warnings: Warning[] = [];
    const limitScorer = {
      score: () => {
        throw new Error(
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits."}}',
        );
      },
    };

    const outcome = await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: limitScorer,
      options: baseOptions,
      onWarning: (w) => warnings.push(w),
    });

    expect(outcome.abortedOnLimit).toBe(true);
    expect(saved.length).toBe(0);
    expect(warnings.some((w) => /usage limit|abort/i.test(w.message))).toBe(true);
  });

  it("deep-scores survivors concurrently (more than one in flight at once)", async () => {
    const candidates = Array.from({ length: 4 }, (_, i) => candidate(`c${i}`, `Engineer ${i}`, 90));
    const { repo, saved } = fakeRepo(candidates);

    let inFlight = 0;
    let maxInFlight = 0;
    const slowScorer = {
      score: async (_p: SkillProfile, p: JobPosting): Promise<MatchResult> => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { score: p.title.length, matchedSkills: [], missingSkills: [], rationale: "deep" };
      },
    };

    const outcome = await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: slowScorer,
      options: { ...baseOptions, limit: candidates.length },
    });

    expect(outcome.counts.deepScored).toBe(candidates.length);
    expect(saved.length).toBe(candidates.length);
    // The serial implementation would peak at 1; the bounded-concurrent one overlaps work.
    expect(maxInFlight).toBeGreaterThan(1);
  });
});

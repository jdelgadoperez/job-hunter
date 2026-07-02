import type { ScoreProgressEvent } from "@app/domain/score-progress";
import type { JobPosting, MatchResult, SkillProfile, Warning } from "@app/domain/types";
import type { ScorerTag, ScoringCandidate } from "@app/storage/repository";
import { describe, expect, it } from "vitest";
import { REMOTE_PENALTY_FACTOR } from "./heuristic-scorer";
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
  opts: {
    location?: string;
    remote?: boolean;
    alreadyLlmScored?: boolean;
    scorer?: ScorerTag;
    matchedSkills?: string[];
    missingSkills?: string[];
  } = {},
): ScoringCandidate {
  const scorer = opts.scorer ?? (opts.alreadyLlmScored ? "llm" : "heuristic");
  return {
    posting: {
      ...posting(id, title, opts.location),
      ...(opts.remote !== undefined ? { remote: opts.remote } : {}),
    },
    current: {
      score: heuristicScore,
      matchedSkills: opts.matchedSkills ?? [],
      missingSkills: opts.missingSkills ?? [],
    },
    heuristicScore,
    scorer,
    alreadyLlmScored: opts.alreadyLlmScored ?? scorer === "llm",
  };
}

/** In-memory ScoreRepo capturing saved results. */
function fakeRepo(candidates: ScoringCandidate[]): {
  repo: ScoreRepo;
  saved: { id: string; result: MatchResult; scorer: ScorerTag }[];
} {
  const saved: { id: string; result: MatchResult; scorer: ScorerTag }[] = [];
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

  it("emits progress events: planning, triaging, triaged, one scoring tick per survivor, done", async () => {
    const candidates = [
      candidate("a", "Staff Engineer", 80),
      candidate("b", "Backend Engineer", 60),
      candidate("c", "Sales Rep", 10), // below floor — not triaged/scored
    ];
    const { repo } = fakeRepo(candidates);
    const events: ScoreProgressEvent[] = [];

    const outcome = await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: baseOptions,
      onProgress: (event) => events.push(event),
    });

    const eligible = outcome.counts.afterHeuristic; // 2 survive the floor
    expect(events[0]).toEqual({ kind: "planning" });
    expect(events).toContainEqual({ kind: "triaging", total: eligible });
    expect(events).toContainEqual({ kind: "triaged", kept: eligible, total: eligible });

    // One scoring tick per deep-scored survivor, counter rising 1..N (completion order).
    const scoring = events.filter((e) => e.kind === "scoring");
    expect(scoring).toHaveLength(outcome.counts.deepScored);
    expect(scoring.map((e) => (e.kind === "scoring" ? e.index : -1))).toEqual(
      Array.from({ length: outcome.counts.deepScored }, (_, i) => i + 1),
    );
    for (const e of scoring) {
      if (e.kind === "scoring") expect(e.total).toBe(outcome.counts.deepScored);
    }
    expect(events.at(-1)).toEqual({ kind: "done", deepScored: outcome.counts.deepScored });
  });

  it("emits no scoring events on a dry run", async () => {
    const candidates = [candidate("a", "Staff Engineer", 80)];
    const events: ScoreProgressEvent[] = [];
    await runScoreRun({
      repo: fakeRepo(candidates).repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, dryRun: true },
      onProgress: (event) => events.push(event),
    });
    expect(events.filter((e) => e.kind === "scoring")).toHaveLength(0);
    expect(events.filter((e) => e.kind === "planning")).toHaveLength(0);
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

  it("applies the limit to UNSCORED postings, not the already-scored top slice", async () => {
    // Regression: the query returns rows best-heuristic-first, and already-scored rows cluster at the
    // top. If the cap were applied before dropping already-scored, `limit` would be spent re-covering
    // that top slice and score fewer NEW postings than requested. Here the two highest-heuristic rows
    // are already scored; with limit=2 the run must still deep-score 2 UNSCORED postings, not 0.
    const candidates = [
      candidate("scored-1", "Already A", 95, { alreadyLlmScored: true }),
      candidate("scored-2", "Already B", 90, { alreadyLlmScored: true }),
      candidate("new-1", "Fresh A", 85),
      candidate("new-2", "Fresh B", 80),
      candidate("new-3", "Fresh C", 75),
    ];
    const { repo, saved } = fakeRepo(candidates);

    const outcome = await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, limit: 2 },
    });

    // limit=2 → the top 2 UNSCORED (new-1, new-2) are scored; the already-scored top slice is skipped.
    expect(outcome.counts.deepScored).toBe(2);
    expect(outcome.counts.alreadyScoredSkipped).toBe(2);
    expect(saved.map((s) => s.id)).toEqual(["new-1", "new-2"]);
  });

  it("partitions remote vs non-remote when remoteOnly is on (unknown location treated as remote)", async () => {
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

    // afterRemote counts only the remote candidates proceeding to the LLM (remote + unknown).
    expect(outcome.counts.afterRemote).toBe(2);

    // Remote and unknown go through LLM (deep-scored).
    const llmSaves = saved
      .filter((s) => s.scorer === "llm")
      .map((s) => s.id)
      .sort();
    expect(llmSaves).toEqual(["remote", "unknown"]);

    // Non-remote (onsite) is saved with a penalized score — not absent — and tagged as penalized.
    const heuristicSave = saved.find((s) => s.id === "onsite");
    expect(heuristicSave?.scorer).toBe("heuristic-remote-penalized");
    expect(saved).toHaveLength(3);
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

describe("runScoreRun — remote partition (remoteOnly=true)", () => {
  it("remote candidates reach the LLM deep-score; non-remote are saved with penalized heuristic", async () => {
    const remotePosting = candidate("rem", "Remote Job", 70, { location: "Remote - US" });
    const officePosting = candidate("off", "Office Job", 60, { location: "New York, NY" });
    const { repo, saved } = fakeRepo([remotePosting, officePosting]);

    await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, remoteOnly: true },
    });

    // Remote posting was deep-scored by the LLM scorer.
    const remoteSave = saved.find((s) => s.id === "rem");
    expect(remoteSave?.scorer).toBe("llm");

    // Non-remote posting was saved with the penalty applied, tagged as penalized.
    const officeSave = saved.find((s) => s.id === "off");
    expect(officeSave?.scorer).toBe("heuristic-remote-penalized");

    // The office posting's heuristic score is the base score * REMOTE_PENALTY_FACTOR.
    // (The fake scorer returns title.length; HeuristicScorer is injected via the repo's
    // listPostingsForScoring which supplies heuristicScore — see the candidate helper.)
    const expectedPenalizedScore = Math.max(
      0,
      Math.round(officePosting.heuristicScore * REMOTE_PENALTY_FACTOR),
    );
    expect(officeSave?.result.score).toBe(expectedPenalizedScore);
  });

  it("penalized score is clamped to 0 for a zero heuristic score", async () => {
    const officePosting = candidate("off0", "Office Zero", 0, { location: "London, UK" });
    const { repo, saved } = fakeRepo([officePosting]);

    await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, remoteOnly: true, minHeuristic: 0 },
    });

    const officeSave = saved.find((s) => s.id === "off0");
    expect(officeSave?.result.score).toBe(0);
  });

  it("remoteOnly=false leaves all candidates going through the LLM pipeline (no penalty)", async () => {
    const remotePosting = candidate("r2", "Remote Job 2", 70, { location: "Remote - US" });
    const officePosting = candidate("o2", "Office Job 2", 60, { location: "Austin, TX" });
    const { repo, saved } = fakeRepo([remotePosting, officePosting]);

    await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, remoteOnly: false },
    });

    // Both go through LLM when remoteOnly is off.
    const scorers = saved.map((s) => s.scorer);
    expect(scorers.every((sc) => sc === "llm")).toBe(true);
    expect(saved).toHaveLength(2);
  });

  it("dry-run with remoteOnly on does NOT save the non-remote penalty", async () => {
    const officePosting = candidate("dry-off", "Dry Office Job", 60, { location: "Chicago, IL" });
    const { repo, saved } = fakeRepo([officePosting]);

    await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, remoteOnly: true, dryRun: true },
    });

    expect(saved).toHaveLength(0);
  });

  it("does not clobber an already-LLM-scored non-remote posting unless rescore is set", async () => {
    const officePosting = candidate("off-llm", "Office Job", 60, {
      location: "New York, NY",
      alreadyLlmScored: true,
    });
    const { repo, saved } = fakeRepo([officePosting]);

    // Without rescore: the prior LLM score is preserved (no penalized heuristic save).
    await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, remoteOnly: true },
    });
    expect(saved).toHaveLength(0);

    // With rescore: the penalty IS applied (the user opted into overwriting).
    await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, remoteOnly: true, rescore: true },
    });
    const penalized = saved.find((s) => s.id === "off-llm");
    expect(penalized?.scorer).toBe("heuristic-remote-penalized");
    expect(penalized?.result.score).toBe(
      Math.max(0, Math.round(officePosting.heuristicScore * REMOTE_PENALTY_FACTOR)),
    );
  });

  it("applies the remote penalty exactly once across repeated runs (no compounding)", async () => {
    // An already-penalized row (tagged heuristic-remote-penalized) must be skipped, so its score
    // doesn't get multiplied by the factor again on the next remote-only run.
    const already = candidate("off-pen", "Office Job", 48, {
      location: "Austin, TX",
      scorer: "heuristic-remote-penalized",
    });
    const { repo, saved } = fakeRepo([already]);

    await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, remoteOnly: true },
    });

    expect(saved).toHaveLength(0); // already penalized → not re-penalized
  });

  it("preserves matched/missing skills when penalizing a non-remote posting", async () => {
    const office = candidate("off-skills", "Office Job", 70, {
      location: "Boston, MA",
      matchedSkills: ["react", "typescript"],
      missingSkills: ["go"],
    });
    const { repo, saved } = fakeRepo([office]);

    await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, remoteOnly: true },
    });

    const penalized = saved.find((s) => s.id === "off-skills");
    expect(penalized?.result.matchedSkills).toEqual(["react", "typescript"]);
    expect(penalized?.result.missingSkills).toEqual(["go"]);
  });

  it("respects the limit cap on the non-remote penalty saves", async () => {
    const offices = Array.from({ length: 5 }, (_, i) =>
      candidate(`off${i}`, `Office Job ${i}`, 60, { location: "Denver, CO" }),
    );
    const { repo, saved } = fakeRepo(offices);

    await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, remoteOnly: true, limit: 2 },
    });

    expect(saved).toHaveLength(2); // capped, not all 5
  });
});

describe("runScoreRun — off-country partition (homeCountry set)", () => {
  it("excludes a foreign on-site role from the LLM and penalizes it", async () => {
    const foreignOnsite = candidate("uk-onsite", "London Job", 80, {
      location: "London, UK",
      remote: false,
    });
    const { repo, saved } = fakeRepo([foreignOnsite]);

    await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, homeCountry: "US" },
    });

    // Never deep-scored (no "llm" save for its id).
    expect(saved.some((s) => s.id === "uk-onsite" && s.scorer === "llm")).toBe(false);

    // Saved with the location penalty applied.
    const penalized = saved.find((s) => s.id === "uk-onsite");
    expect(penalized?.scorer).toBe("heuristic-location-penalized");
    expect(penalized?.result.score).toBe(
      Math.max(0, Math.round(foreignOnsite.heuristicScore * REMOTE_PENALTY_FACTOR)),
    );
  });

  it("lets a foreign REMOTE role and an unknown-country role reach the LLM", async () => {
    const foreignRemote = candidate("uk-remote", "Remote London Job", 70, {
      location: "London, UK",
      remote: true,
    });
    const unknown = candidate("unknown", "Unknown Job", 75, {
      location: "San Francisco",
      remote: false,
    });
    const { repo, saved } = fakeRepo([foreignRemote, unknown]);

    await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, homeCountry: "US" },
    });

    // Both reach the LLM deep-score.
    expect(saved.find((s) => s.id === "uk-remote")?.scorer).toBe("llm");
    expect(saved.find((s) => s.id === "unknown")?.scorer).toBe("llm");
    // Neither is location-penalized.
    expect(saved.some((s) => s.scorer === "heuristic-location-penalized")).toBe(false);
  });

  it("applies the location penalty exactly once across repeated runs (no compounding)", async () => {
    const already = candidate("uk-pen", "London Job", 48, {
      location: "London, UK",
      remote: false,
      scorer: "heuristic-location-penalized",
    });
    const { repo, saved } = fakeRepo([already]);

    await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, homeCountry: "US" },
    });

    expect(saved).toHaveLength(0); // already penalized → not re-penalized
  });

  it("homeCountry unset leaves a foreign on-site role going through the LLM (no penalty)", async () => {
    const foreignOnsite = candidate("uk-nohome", "London Job", 80, {
      location: "London, UK",
      remote: false,
    });
    const { repo, saved } = fakeRepo([foreignOnsite]);

    await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: baseOptions,
    });

    expect(saved.find((s) => s.id === "uk-nohome")?.scorer).toBe("llm");
    expect(saved.some((s) => s.scorer === "heuristic-location-penalized")).toBe(false);
  });

  it("penalizes a foreign non-remote role exactly once under remoteOnly + homeCountry (single tag)", async () => {
    // The role is non-remote, so the remote gate already routes it to nonRemotePenalized (tagged
    // heuristic-remote-penalized). Because offCountry derives from afterRemote, it can't also land
    // in the off-country partition — so there must be exactly ONE save with the remote tag.
    const foreignOnsite = candidate("uk-both", "London Job", 60, {
      location: "London, UK",
      remote: false,
    });
    const { repo, saved } = fakeRepo([foreignOnsite]);

    await runScoreRun({
      repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, remoteOnly: true, homeCountry: "US" },
    });

    const forId = saved.filter((s) => s.id === "uk-both");
    expect(forId).toHaveLength(1);
    expect(forId[0]?.scorer).toBe("heuristic-remote-penalized");
  });

  it("scores fewer titles (saves tokens) when homeCountry excludes foreign on-site roles", async () => {
    const makeCandidates = () => [
      candidate("us-home", "Austin Job", 80, { location: "Austin, Texas", remote: false }),
      candidate("uk-onsite", "London Job", 78, { location: "London, UK", remote: false }),
    ];

    const withoutHome = await runScoreRun({
      repo: fakeRepo(makeCandidates()).repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: baseOptions,
    });
    const withHome = await runScoreRun({
      repo: fakeRepo(makeCandidates()).repo,
      profile,
      triager: keepAllTriager(),
      scorer: deepScorer,
      options: { ...baseOptions, homeCountry: "US" },
    });

    // The UK on-site role is triaged/deep-scored without a home country, excluded with one.
    expect(withHome.counts.triageTitles).toBeLessThan(withoutHome.counts.triageTitles);
    expect(withoutHome.counts.triageTitles - withHome.counts.triageTitles).toBe(1);
    expect(withHome.counts.locationPenalized).toBe(1);
    // The in-country role is still triaged/scored in both.
    expect(withHome.counts.triageTitles).toBe(1);
  });
});

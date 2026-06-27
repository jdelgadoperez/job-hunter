import type { JobPosting, MatchResult, Scorer, SkillProfile, Warning } from "@app/domain/types";
import { errorMessage } from "@app/net/error-message";
import type { ScoringCandidate } from "@app/storage/repository";
import { type CostEstimate, estimateCost } from "./cost-estimate";
import type { LlmTriager } from "./llm-triager";
import { isRemote } from "./remote-filter";
import type { TriageItem } from "./triage-prompt";

const WARNING_SOURCE = "score";

/** A provider usage-limit / auth failure — the signal to stop making new LLM calls immediately. */
export function isUsageLimitError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("usage limit") ||
    message.includes("usage limits") ||
    message.includes("rate limit") ||
    message.includes("authentication")
  );
}

export type ScoreOptions = {
  minHeuristic: number;
  limit: number;
  remoteOnly: boolean;
  rescore: boolean;
  dryRun: boolean;
  batchSize: number;
  cost: { perTriageTitleUsd: number; perDeepScoreUsd: number };
};

export type ScoreStageCounts = {
  inDb: number;
  afterRemote: number;
  afterHeuristic: number;
  afterCap: number;
  alreadyScoredSkipped: number;
  triageTitles: number;
  deepScored: number;
};

export type ScoreOutcome = {
  counts: ScoreStageCounts;
  estimate: CostEstimate;
  warnings: Warning[];
  abortedOnLimit: boolean;
};

/** Structural repo subset score-run needs — keeps the orchestrator unit-testable without SQLite. */
export type ScoreRepo = {
  countLivePostings(): number;
  listPostingsForScoring(opts: { minHeuristic: number }): ScoringCandidate[];
  saveMatchResult(id: string, result: MatchResult, scorer: "heuristic" | "llm"): void;
};

/**
 * Run the `score` pipeline over postings already in the DB: heuristic gate → remote filter (the
 * repo query applies the floor) → cap → skip-already-scored → batch title-triage → deep score.
 * Dry-run computes the plan + estimate and returns before any LLM call. Deep-scoring aborts on the
 * first usage-limit error (no point hammering a hard limit). Never throws; warnings are collected.
 */
export async function runScoreRun(deps: {
  repo: ScoreRepo;
  profile: SkillProfile;
  triager: LlmTriager;
  scorer: Scorer;
  options: ScoreOptions;
  onWarning?: (warning: Warning) => void;
}): Promise<ScoreOutcome> {
  const { repo, profile, triager, scorer, options, onWarning } = deps;
  const warnings: Warning[] = [];
  const warn = (message: string) => {
    const warning = { source: WARNING_SOURCE, message };
    warnings.push(warning);
    onWarning?.(warning);
  };

  // True total of non-expired postings in the DB, before any filtering.
  const inDb = repo.countLivePostings();

  // Heuristic gate is applied by the query (score >= minHeuristic).
  const gated = repo.listPostingsForScoring({ minHeuristic: options.minHeuristic });

  const afterRemote = options.remoteOnly
    ? gated.filter((c) => isRemote(c.posting.location))
    : gated;

  const capped = afterRemote.slice(0, options.limit);

  const eligible = options.rescore ? capped : capped.filter((c) => !c.alreadyLlmScored);
  const alreadyScoredSkipped = capped.length - eligible.length;

  const counts: ScoreStageCounts = {
    inDb,
    afterRemote: afterRemote.length,
    afterHeuristic: gated.length,
    afterCap: capped.length,
    alreadyScoredSkipped,
    triageTitles: eligible.length,
    deepScored: 0,
  };

  const estimate = estimateCost({
    triageTitles: eligible.length,
    deepScores: eligible.length,
    batchSize: options.batchSize,
    cost: options.cost,
  });

  if (options.dryRun) {
    return { counts, estimate, warnings, abortedOnLimit: false };
  }

  // Stage 4 — batch title triage (fail-open inside the triager).
  const items: TriageItem[] = eligible.map((c) => ({
    id: c.posting.id,
    title: c.posting.title,
    ...(c.posting.location ? { location: c.posting.location } : {}),
  }));
  const { keptIds } = await triager.triage(profile, items);
  const survivors = eligible.filter((c) => keptIds.has(c.posting.id));

  // Stage 5 — deep score, aborting on the first usage-limit error.
  let abortedOnLimit = false;
  for (const candidate of survivors) {
    try {
      const result = await scoreOne(scorer, profile, candidate.posting);
      repo.saveMatchResult(candidate.posting.id, result, "llm");
      counts.deepScored += 1;
    } catch (error) {
      if (isUsageLimitError(error)) {
        abortedOnLimit = true;
        warn(
          `hit the provider usage limit after ${counts.deepScored} deep score(s); ` +
            `${survivors.length - counts.deepScored} remaining were not scored`,
        );
        break;
      }
      warn(`deep score failed for ${candidate.posting.title}: ${errorMessage(error)}`);
    }
  }

  return { counts, estimate, warnings, abortedOnLimit };
}

/** Await a `Scorer.score` whether it returns a value or a promise. */
async function scoreOne(
  scorer: Scorer,
  profile: SkillProfile,
  posting: JobPosting,
): Promise<MatchResult> {
  return scorer.score(profile, posting);
}

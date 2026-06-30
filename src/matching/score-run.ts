import type { JobPosting, MatchResult, Scorer, SkillProfile, Warning } from "@app/domain/types";
import { errorMessage } from "@app/net/error-message";
import type { ScorerTag, ScoringCandidate } from "@app/storage/repository";
import pLimit from "p-limit";
import { type CostEstimate, estimateCost } from "./cost-estimate";
import { applyRemotePenalty } from "./heuristic-scorer";
import type { LlmTriager } from "./llm-triager";
import { resolvePostingRemote } from "./remote-filter";
import type { TriageItem } from "./triage-prompt";
import { isUsageLimitError } from "./usage-limit-error";

export { isUsageLimitError } from "./usage-limit-error";

const WARNING_SOURCE = "score";

// Deep scores are independent network-bound LLM calls, so a small concurrency cap turns the serial
// wait into parallel throughput without hammering the provider (mirrors runScan's SCORE_CONCURRENCY).
const DEEP_SCORE_CONCURRENCY = 4;

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
  /** Non-remote postings saved a penalized heuristic score this run (only under remoteOnly). */
  remotePenalized: number;
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
  saveMatchResult(id: string, result: MatchResult, scorer: ScorerTag): void;
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

  // When remoteOnly is on, partition rather than filter:
  //   - Remote candidates proceed through the full pipeline (triage → LLM deep-score).
  //   - Non-remote candidates skip the LLM but are saved with a penalized heuristic score,
  //     so they appear in Matches ranked low rather than being absent.
  // When remoteOnly is off, no partition and no penalty — same pipeline as before.
  let afterRemote: ScoringCandidate[];
  let nonRemotePenalized: ScoringCandidate[];

  if (options.remoteOnly) {
    afterRemote = gated.filter((c) => resolvePostingRemote(c.posting));
    nonRemotePenalized = gated.filter((c) => !resolvePostingRemote(c.posting));
  } else {
    afterRemote = gated;
    nonRemotePenalized = [];
  }

  const capped = afterRemote.slice(0, options.limit);

  const eligible = options.rescore ? capped : capped.filter((c) => !c.alreadyLlmScored);
  const alreadyScoredSkipped = capped.length - eligible.length;

  // Determine which non-remote postings get a penalized heuristic score (the actual save happens
  // after the dry-run gate). These never reach the triager or LLM, so there's no cost and no
  // usage-limit risk. The penalty is applied to the posting's EXISTING result — preserving its
  // matched/missing skills and rationale — and exactly ONCE: a row already tagged
  // `heuristic-remote-penalized` is skipped so repeated remote-only runs don't compound the penalty.
  // Already-LLM-scored rows are skipped too (unless --rescore), matching the remote path. The cap is
  // respected so a remote-only run doesn't do unbounded writes.
  const nonRemoteToPenalize = nonRemotePenalized
    .filter((c) => c.scorer !== "heuristic-remote-penalized")
    .filter((c) => options.rescore || !c.alreadyLlmScored)
    .slice(0, options.limit);

  const counts: ScoreStageCounts = {
    inDb,
    afterRemote: afterRemote.length,
    afterHeuristic: gated.length,
    afterCap: capped.length,
    alreadyScoredSkipped,
    triageTitles: eligible.length,
    deepScored: 0,
    remotePenalized: nonRemoteToPenalize.length,
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

  for (const c of nonRemoteToPenalize) {
    repo.saveMatchResult(c.posting.id, applyRemotePenalty(c.current), "heuristic-remote-penalized");
  }

  // Stage 4 — batch title triage (fail-open inside the triager for ordinary errors).
  // A usage-limit error from triage propagates out of the triager (it does NOT fail-open those);
  // catch it here so we can abort cleanly without entering the deep-score loop.
  const items: TriageItem[] = eligible.map((c) => ({
    id: c.posting.id,
    title: c.posting.title,
    ...(c.posting.location ? { location: c.posting.location } : {}),
  }));

  let keptIds: Set<string>;
  try {
    ({ keptIds } = await triager.triage(profile, items));
  } catch (error) {
    if (isUsageLimitError(error)) {
      warn("hit the provider usage limit during triage; no postings were deep-scored");
      return { counts, estimate, warnings, abortedOnLimit: true };
    }
    throw error; // unexpected: let it bubble (triager should not throw non-limit errors)
  }

  const survivors = eligible.filter((c) => keptIds.has(c.posting.id));

  // Stage 5 — deep score concurrently (bounded). Once a usage-limit error surfaces we stop launching
  // new work; scores already in flight are allowed to finish (no point discarding completed work).
  // JS is single-threaded, so the `counts.deepScored += 1` and synchronous `saveMatchResult` after
  // each await can't interleave mid-statement.
  const limit = pLimit(DEEP_SCORE_CONCURRENCY);
  let abortedOnLimit = false;
  await Promise.all(
    survivors.map((candidate) =>
      limit(async () => {
        if (abortedOnLimit) return; // a prior task hit the hard limit — don't start new ones.
        try {
          const result = await scoreOne(scorer, profile, candidate.posting);
          repo.saveMatchResult(candidate.posting.id, result, "llm");
          counts.deepScored += 1;
        } catch (error) {
          if (isUsageLimitError(error)) {
            abortedOnLimit = true;
            return;
          }
          warn(`deep score failed for ${candidate.posting.title}: ${errorMessage(error)}`);
        }
      }),
    ),
  );
  if (abortedOnLimit) {
    warn(
      `hit the provider usage limit after ${counts.deepScored} deep score(s); ` +
        `${survivors.length - counts.deepScored} remaining were not scored`,
    );
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

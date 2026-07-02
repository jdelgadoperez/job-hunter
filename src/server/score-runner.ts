import { style } from "@app/cli/style";
import { formatScoreProgress, type ScoreProgressEvent } from "@app/domain/score-progress";
import type { Warning } from "@app/domain/types";
import { createAbortingScorer } from "@app/matching/aborting-scorer";
import { HeuristicScorer } from "@app/matching/heuristic-scorer";
import { DEFAULT_TRIAGE_BATCH_SIZE, LlmTriager } from "@app/matching/llm-triager";
import {
  resolveApiKey,
  resolveProvider,
  resolveScorerModel,
  settingsWithEnvKey,
} from "@app/matching/resolve-settings";
import { DEFAULT_MIN_HEURISTIC } from "@app/matching/score-defaults";
import { runScoreRun } from "@app/matching/score-run";
import { AnthropicTriageClient } from "@app/matching/triage-client";
import type { Repository } from "@app/storage/repository";
import type { ScoreResult } from "./score-job";
import type { ScoreRunner, ScoreRunOptions } from "./types";

/**
 * Thrown when a deep-score is requested without an Anthropic key configured. The job manager records
 * the message as the job's error, and the preview route returns it as a 400. Kept distinct so the UI
 * can tell "no key" apart from a mid-run failure.
 */
export class NoApiKeyError extends Error {
  constructor() {
    super("No Anthropic key configured. Add one in Settings to deep-score with Claude.");
    this.name = "NoApiKeyError";
  }
}

/**
 * Assemble the deep-score pipeline for `runScoreRun`, mirroring the CLI's `runScoreCommand`:
 * resolve provider/key/model (with the `ANTHROPIC_API_KEY` env fallback), build the shared
 * abort-on-usage-limit scorer and the triager. Throws `NoApiKeyError` if no key is available.
 * `dryRun` short-circuits inside `runScoreRun` before any LLM call.
 */
async function runDeepScore(
  repo: Repository,
  options: ScoreRunOptions,
  dryRun: boolean,
  onProgress?: (event: ScoreProgressEvent) => void,
): Promise<ScoreResult> {
  const profile = repo.getLatestProfile();
  if (!profile) throw new Error("No profile yet. Upload a resume first.");

  const settings = settingsWithEnvKey(repo);
  const provider = resolveProvider(settings);
  const apiKey = resolveApiKey(settings, provider);
  if (!apiKey) throw new NoApiKeyError();
  const model = resolveScorerModel(settings, provider);

  const dictionary = repo.getSkillDictionary();
  const warnings: Warning[] = [];
  const heuristic = new HeuristicScorer(dictionary.length > 0 ? dictionary : undefined);

  const rawClient = provider.createClient({ apiKey, model });
  const scorer = createAbortingScorer({
    client: rawClient,
    heuristic,
    remoteOnly: options.remoteOnly,
    onWarning: (warning) => warnings.push(warning),
  });

  const triager = new LlmTriager(
    new AnthropicTriageClient({ apiKey, model }),
    DEFAULT_TRIAGE_BATCH_SIZE,
    (warning) => warnings.push(warning),
  );

  const outcome = await runScoreRun({
    repo,
    profile,
    triager,
    scorer,
    options: {
      minHeuristic: DEFAULT_MIN_HEURISTIC,
      limit: options.limit,
      remoteOnly: options.remoteOnly,
      rescore: options.rescore,
      dryRun,
      batchSize: DEFAULT_TRIAGE_BATCH_SIZE,
      cost: provider.cost,
    },
    onWarning: (warning) => warnings.push(warning),
    ...(onProgress ? { onProgress } : {}),
  });

  return {
    counts: outcome.counts,
    estimate: outcome.estimate,
    warnings: outcome.warnings,
    abortedOnLimit: outcome.abortedOnLimit,
  };
}

/** Build a background deep-score runner for the given options (real LLM calls). Smoke-only.
 * Mirrors `createScanRun`: forwards each progress event to the job status AND echoes every event to
 * the server console as `[score] …`. */
export function createScoreRun(repo: Repository) {
  return (options: ScoreRunOptions): ScoreRunner =>
    (onProgress) =>
      runDeepScore(repo, options, false, (event) => {
        onProgress(event);
        console.log(`${style.dim("[score]")} ${formatScoreProgress(event)}`);
      });
}

/** Synchronous dry-run: the plan + cost estimate, with zero LLM calls. */
export function previewScore(repo: Repository) {
  return (options: ScoreRunOptions): Promise<ScoreResult> => runDeepScore(repo, options, true);
}

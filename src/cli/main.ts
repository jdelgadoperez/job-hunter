import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveShareUrl } from "@app/discovery/sources/airtable";
import { PlaywrightSharedViewReader } from "@app/discovery/sources/airtable-playwright";
import { formatProgress } from "@app/domain/scan-progress";
import type { JobPosting, MatchResult, Scorer, SkillProfile, Warning } from "@app/domain/types";
import { HeuristicScorer } from "@app/matching/heuristic-scorer";
import { MatchPayloadSchema } from "@app/matching/llm-schema";
import { LlmTriager } from "@app/matching/llm-triager";
import { resolveRemoteOnly } from "@app/matching/resolve-remote";
import {
  resolveApiKey,
  resolveProvider,
  resolveScorerModel,
  settingsWithEnvKey,
} from "@app/matching/resolve-settings";
import { buildScorePrompt, toMatchResult } from "@app/matching/score-prompt";
import { isUsageLimitError, runScoreRun } from "@app/matching/score-run";
import { REMOTE_ONLY_SETTING } from "@app/matching/settings-keys";
import { AnthropicTriageClient } from "@app/matching/triage-client";
import { errorMessage } from "@app/net/error-message";
import { HttpFetcher } from "@app/net/fetcher";
import { PlaywrightRenderer } from "@app/net/playwright-renderer";
import { readResumeText } from "@app/profile/read-resume";
import { ensureDataDir, resolveDbPath } from "@app/runtime/paths";
import { getVersion } from "@app/runtime/version";
import { startServer } from "@app/server/serve";
import { Repository } from "@app/storage/repository";
import {
  type Logger,
  formatScorePlan,
  listMatches,
  runProfile,
  runScan,
  trackAdd,
  trackList,
  trackRemove,
} from "./commands";
import { renderHelp } from "./help";
import { parseCli } from "./parse";
import { style } from "./style";

const TRIAGE_BATCH_SIZE = 40;

export type ScoreCliOptions = {
  minHeuristic: number;
  limit: number;
  remoteOnly?: boolean;
  rescore: boolean;
  dryRun: boolean;
};

export async function runScanCommand(repo: Repository, log: Logger): Promise<void> {
  const profile = repo.getLatestProfile();
  if (!profile) {
    log(style.warn("No profile yet. Run `job-hunter profile <resume-file>` first."));
    process.exitCode = 1;
    return;
  }

  const dictionary = repo.getSkillDictionary();
  const scorer = new HeuristicScorer(dictionary.length > 0 ? dictionary : undefined);

  const result = await runScan(
    {
      repo,
      profile,
      scorer,
      // Live status so a scan is never silent: directory read, per-company, scoring.
      // Dimmed as secondary chatter — the final summary stands out in full color.
      onProgress: (event) => log(style.dim(formatProgress(event))),
      discoverDeps: {
        fetcher: new HttpFetcher(),
        renderer: new PlaywrightRenderer(),
        sharedViewReader: new PlaywrightSharedViewReader(),
        shareUrl: resolveShareUrl(),
        trackedCompanies: repo.listTrackedCompanies(),
      },
    },
    // The summary line is already emitted via onProgress; keep the logger quiet to avoid dupes.
    () => {},
  );
  // Surface discovery warnings after the summary.
  for (const warning of result.warnings) {
    log(style.warn(`  ! [${warning.source}] ${warning.message}`));
  }
}

export async function runScoreCommand(
  repo: Repository,
  options: ScoreCliOptions,
  log: Logger,
): Promise<void> {
  const profile = repo.getLatestProfile();
  if (!profile) {
    log(style.warn("No profile yet. Run `job-hunter profile <resume-file>` first."));
    process.exitCode = 1;
    return;
  }

  const settings = settingsWithEnvKey(repo);
  const provider = resolveProvider(settings);
  const apiKey = resolveApiKey(settings, provider);
  if (!apiKey) {
    log(
      style.warn(
        "No LLM key configured; nothing to score (scan already heuristic-scored everything).",
      ),
    );
    return;
  }

  const model = resolveScorerModel(settings, provider);
  const dictionary = repo.getSkillDictionary();
  const warnings: Warning[] = [];
  const remoteOnly = resolveRemoteOnly(settings, options.remoteOnly);

  // Deep-score against the raw provider client. We do NOT reuse `LlmScorer` here because it
  // degrades EVERY failure (including a usage-limit error) into the heuristic fallback, which
  // would hide the very signal `score-run` needs to abort the run. Instead this scorer degrades
  // ordinary failures to the heuristic but re-throws usage-limit errors so `runScoreRun` can stop.
  const heuristic = new HeuristicScorer(dictionary.length > 0 ? dictionary : undefined);
  const rawClient = provider.createClient({ apiKey, model });
  const abortingScorer: Scorer = {
    score: async (profileArg: SkillProfile, posting: JobPosting): Promise<MatchResult> => {
      try {
        const payload = await rawClient.score(buildScorePrompt(profileArg, posting));
        const parsed = MatchPayloadSchema.safeParse(payload);
        if (!parsed.success) return heuristic.score(profileArg, posting);
        return toMatchResult(parsed.data);
      } catch (error) {
        if (isUsageLimitError(error)) throw error; // let score-run abort the whole run
        warnings.push({
          source: "llm-scorer",
          message: `LLM scoring failed: ${errorMessage(error)}; using the heuristic scorer`,
        });
        return heuristic.score(profileArg, posting);
      }
    },
  };

  const triager = new LlmTriager(
    new AnthropicTriageClient({ apiKey, model }),
    TRIAGE_BATCH_SIZE,
    (warning) => warnings.push(warning),
  );

  const outcome = await runScoreRun({
    repo,
    profile,
    triager,
    scorer: abortingScorer,
    options: {
      minHeuristic: options.minHeuristic,
      limit: options.limit,
      remoteOnly,
      rescore: options.rescore,
      dryRun: options.dryRun,
      batchSize: TRIAGE_BATCH_SIZE,
      cost: provider.cost,
    },
    onWarning: (warning) => warnings.push(warning),
  });

  log(
    formatScorePlan(outcome, {
      remoteOnly,
      limit: options.limit,
      dryRun: options.dryRun,
    }),
  );
  for (const warning of warnings) {
    log(style.warn(`  ! [${warning.source}] ${warning.message}`));
  }
}

export async function main(): Promise<void> {
  const command = parseCli(process.argv.slice(2));
  const log: Logger = (message) => console.log(message);

  if (command.kind === "help") {
    if (command.error) console.error(style.error(`Error: ${command.error}\n`));
    console.log(renderHelp(command.topic));
    process.exitCode = command.error ? 1 : 0;
    return;
  }

  if (command.kind === "version") {
    console.log(`job-hunter ${getVersion()}`);
    return;
  }

  // `serve` is long-running and owns its repository for the server's lifetime, so it runs
  // outside the open-use-close block the one-shot commands share.
  if (command.kind === "serve") {
    await startServer({
      port: command.port,
      open: command.open,
      refreshHours: command.refreshHours,
    });
    return;
  }

  ensureDataDir();
  const repo = new Repository(resolveDbPath());
  try {
    switch (command.kind) {
      case "track-add":
        trackAdd(repo, command.url, command.name, log);
        break;
      case "track-list":
        trackList(repo, log);
        break;
      case "track-remove":
        trackRemove(repo, command.url, log);
        break;
      case "profile":
        await runProfile({ repo, readResume: readResumeText }, command.resumePath, log);
        break;
      case "list":
        listMatches(repo, command.minScore, log);
        break;
      case "scan":
        await runScanCommand(repo, log);
        break;
      case "score":
        await runScoreCommand(
          repo,
          {
            minHeuristic: command.minHeuristic,
            limit: command.limit,
            ...(command.remoteOnly !== undefined ? { remoteOnly: command.remoteOnly } : {}),
            rescore: command.rescore,
            dryRun: command.dryRun,
          },
          log,
        );
        break;
      case "config-remote":
        repo.setSetting(REMOTE_ONLY_SETTING, command.on ? "true" : "false");
        log(style.success(`Remote-only filter ${command.on ? "enabled" : "disabled"}.`));
        break;
    }
  } finally {
    repo.close();
  }
}

// Run only when executed as the CLI entrypoint, not when imported by tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(style.error(String(error)));
    process.exitCode = 1;
  });
}

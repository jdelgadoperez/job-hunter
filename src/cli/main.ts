import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DiscoverDeps } from "@app/discovery/discover";
import { resolvePostingFeed } from "@app/discovery/feed/resolve-feed";
import type { ScanScope } from "@app/discovery/scan-store";
import { resolveShareUrl } from "@app/discovery/sources/airtable";
import { PlaywrightSharedViewReader } from "@app/discovery/sources/airtable-playwright";
import { formatProgress } from "@app/domain/scan-progress";
import type { Warning } from "@app/domain/types";
import { createAbortingScorer } from "@app/matching/aborting-scorer";
import { HeuristicScorer } from "@app/matching/heuristic-scorer";
import { DEFAULT_TRIAGE_BATCH_SIZE, LlmTriager } from "@app/matching/llm-triager";
import { formatUsageSummary, UsageAccumulator } from "@app/matching/llm-usage";
import { resolveRemoteOnly } from "@app/matching/resolve-remote";
import {
  resolveApiKey,
  resolveHomeCountry,
  resolveProvider,
  resolveScanFreshnessHours,
  resolveScorerModel,
  settingsWithEnvKey,
} from "@app/matching/resolve-settings";
import { runScoreRun } from "@app/matching/score-run";
import { REMOTE_ONLY_SETTING } from "@app/matching/settings-keys";
import { AnthropicTriageClient } from "@app/matching/triage-client";
import { HttpFetcher } from "@app/net/fetcher";
import { PlaywrightRenderer } from "@app/net/playwright-renderer";
import { readResumeText } from "@app/profile/read-resume";
import { checkNodeVersion } from "@app/runtime/node-version";
import { ensureDataDir, resolveDbPath } from "@app/runtime/paths";
import { getVersion } from "@app/runtime/version";
import { startServer } from "@app/server/serve";
import { Repository } from "@app/storage/repository";
import {
  formatScorePlan,
  type Logger,
  listMatches,
  runProfile,
  runScan,
  trackAdd,
  trackList,
  trackRemove,
} from "./commands";
import { createDiagnostics, type Diagnostics } from "./diagnostics";
import { renderHelp } from "./help";
import { hasVerboseFlag, parseCli } from "./parse";
import { runServiceCommand } from "./service";
import { style } from "./style";

export type ScoreCliOptions = {
  minHeuristic: number;
  limit: number;
  remoteOnly?: boolean;
  rescore: boolean;
  dryRun: boolean;
  json: boolean;
};

export type ScanCliOptions = {
  retryFailed: boolean;
  all: boolean;
  freshnessHours?: number;
};

export async function runScanCommand(
  repo: Repository,
  log: Logger,
  opts: ScanCliOptions,
  diagnostics: Diagnostics,
): Promise<void> {
  const profile = repo.getLatestProfile();
  if (!profile) {
    diagnostics.diag(style.warn("No profile yet. Run `job-hunter profile <resume-file>` first."));
    process.exitCode = 1;
    return;
  }

  let trackedCompanies = repo.listTrackedCompanies();
  let sources: DiscoverDeps["sources"] | undefined;
  if (opts.retryFailed) {
    const needsAttention = repo.listNeedsAttention();
    if (needsAttention.length === 0) {
      log(style.dim("Nothing needs attention — every company scanned cleanly recently."));
      return;
    }
    trackedCompanies = needsAttention.map((c) => ({ careersUrl: c.careersUrl, name: c.company }));
    // Scope the *local crawl* to just these companies, not the full directory. When a remote feed
    // is configured (hybrid mode), the feed is scoped too: runScan filters it to these companyIds.
    // Feed postings from an older worker that predate the company_id column carry no companyId and
    // so fall outside the scoped set (they're excluded here, not dropped from full scans).
    sources = [];
  }

  const dictionary = repo.getSkillDictionary();
  const scorer = new HeuristicScorer(dictionary.length > 0 ? dictionary : undefined);

  const fetcher = new HttpFetcher();
  // Hybrid remote mode when a feed is configured: pull the shared feed + crawl only tracked companies.
  const feed = resolvePostingFeed(repo, fetcher);
  const settings = settingsWithEnvKey(repo);
  const scanScope: ScanScope = opts.retryFailed ? "retry" : opts.all ? "full" : "incremental";
  const freshnessHours =
    scanScope === "incremental"
      ? (opts.freshnessHours ?? resolveScanFreshnessHours(settings))
      : undefined;

  const result = await runScan(
    {
      repo,
      profile,
      scorer,
      ...(feed ? { feed } : {}),
      scope: scanScope,
      ...(freshnessHours !== undefined ? { freshnessHours } : {}),
      // Live status so a scan is never silent: directory read, per-company, scoring.
      // Dimmed as secondary chatter — the final summary stands out in full color.
      onProgress: (event) => diagnostics.diag(style.dim(formatProgress(event))),
      discoverDeps: {
        fetcher,
        renderer: new PlaywrightRenderer(),
        sharedViewReader: new PlaywrightSharedViewReader(),
        shareUrl: resolveShareUrl(),
        trackedCompanies,
        settings,
        ...(sources ? { sources } : {}),
      },
    },
    // The summary line is already emitted via onProgress; keep the logger quiet to avoid dupes.
    () => {},
  );
  // Surface discovery warnings after the summary.
  for (const warning of result.warnings) {
    diagnostics.diag(style.warn(`  ! [${warning.source}] ${warning.message}`));
  }
}

export async function runScoreCommand(
  repo: Repository,
  options: ScoreCliOptions,
  log: Logger,
  diagnostics: Diagnostics,
): Promise<void> {
  const profile = repo.getLatestProfile();
  if (!profile) {
    diagnostics.diag(style.warn("No profile yet. Run `job-hunter profile <resume-file>` first."));
    process.exitCode = 1;
    return;
  }

  const settings = settingsWithEnvKey(repo);
  const provider = resolveProvider(settings);
  const apiKey = resolveApiKey(settings, provider);
  if (!apiKey) {
    diagnostics.diag(
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
  const homeCountry = resolveHomeCountry(settings);

  // Deep-score against the raw provider client. We do NOT reuse `LlmScorer` here because it
  // degrades EVERY failure (including a usage-limit error) into the heuristic fallback, which
  // would hide the very signal `score-run` needs to abort the run. Instead this scorer degrades
  // ordinary failures to the heuristic but re-throws usage-limit errors so `runScoreRun` can stop.
  // Accumulate per-call usage from both LLM steps so the summary can report whether the cached
  // system prefix actually engaged (a sub-threshold prefix caches nothing — see docs/prompt-caching.md).
  const usage = new UsageAccumulator();
  const onUsage = (u: Parameters<typeof usage.add>[0]) => usage.add(u);

  const heuristic = new HeuristicScorer(dictionary.length > 0 ? dictionary : undefined);
  const rawClient = provider.createClient({ apiKey, model, onUsage });
  const abortingScorer = createAbortingScorer({
    client: rawClient,
    heuristic,
    remoteOnly,
    onWarning: (warning) => warnings.push(warning),
  });

  const triager = new LlmTriager(
    new AnthropicTriageClient({ apiKey, model, onUsage }),
    DEFAULT_TRIAGE_BATCH_SIZE,
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
      batchSize: DEFAULT_TRIAGE_BATCH_SIZE,
      cost: provider.cost,
      ...(homeCountry !== undefined ? { homeCountry } : {}),
    },
    onWarning: (warning) => warnings.push(warning),
  });

  if (options.json) {
    log(JSON.stringify(outcome, null, 2));
  } else {
    log(
      formatScorePlan(outcome, {
        remoteOnly,
        limit: options.limit,
        dryRun: options.dryRun,
      }),
    );
    const usageSummary = formatUsageSummary(usage);
    if (usageSummary) diagnostics.diag(style.dim(usageSummary));
  }
  for (const warning of warnings) {
    diagnostics.diag(style.warn(`  ! [${warning.source}] ${warning.message}`));
  }
}

export async function main(): Promise<void> {
  const versionWarning = checkNodeVersion(process.versions.node);
  if (versionWarning) console.error(style.warn(versionWarning));

  const command = parseCli(process.argv.slice(2));
  const log: Logger = (message) => console.log(message);
  const verbose = hasVerboseFlag(process.argv.slice(2));
  const jsonMode = command.kind === "list" || command.kind === "score" ? command.json : false;
  const diagnostics = createDiagnostics({ verbose, json: jsonMode });

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

  // `service` just shells out to the per-platform background-service script — it needs no database,
  // so it runs before the repository is opened. Its exit code becomes ours.
  if (command.kind === "service") {
    process.exitCode = await runServiceCommand(command.action);
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
        listMatches(repo, command.minScore, log, {
          remoteOnly: command.remoteOnly,
          country: command.country,
          includeApplied: command.includeApplied,
          onlyApplied: command.onlyApplied,
          json: command.json,
          diag: diagnostics.diag,
        });
        break;
      case "scan":
        await runScanCommand(
          repo,
          log,
          {
            retryFailed: command.retryFailed,
            all: command.all,
            ...(command.freshnessHours !== undefined
              ? { freshnessHours: command.freshnessHours }
              : {}),
          },
          diagnostics,
        );
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
            json: command.json,
          },
          log,
          diagnostics,
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
    console.error(style.dim("Report this: https://github.com/jdelgadoperez/job-hunter/issues/new"));
    process.exitCode = 1;
  });
}

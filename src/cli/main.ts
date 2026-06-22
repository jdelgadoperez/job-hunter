import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveShareUrl } from "@app/discovery/sources/airtable";
import { PlaywrightSharedViewReader } from "@app/discovery/sources/airtable-playwright";
import { formatProgress } from "@app/domain/scan-progress";
import type { Warning } from "@app/domain/types";
import { resolveScorer } from "@app/matching/resolve-scorer";
import { settingsWithEnvKey } from "@app/matching/resolve-settings";
import { HttpFetcher } from "@app/net/fetcher";
import { PlaywrightRenderer } from "@app/net/playwright-renderer";
import { readResumeText } from "@app/profile/read-resume";
import { ensureDataDir, resolveDbPath } from "@app/runtime/paths";
import { startServer } from "@app/server/serve";
import { Repository } from "@app/storage/repository";
import {
  type Logger,
  listMatches,
  runProfile,
  runScan,
  trackAdd,
  trackList,
  trackRemove,
} from "./commands";
import { USAGE, parseCli } from "./parse";

export async function runScanCommand(repo: Repository, log: Logger): Promise<void> {
  const profile = repo.getLatestProfile();
  if (!profile) {
    log("No profile yet. Run `job-hunter profile <resume-file>` first.");
    process.exitCode = 1;
    return;
  }

  const warnings: Warning[] = [];
  const dictionary = repo.getSkillDictionary();
  const scorer = resolveScorer({
    settings: settingsWithEnvKey(repo),
    dictionary: dictionary.length > 0 ? dictionary : undefined,
    onWarning: (warning) => warnings.push(warning),
  });

  const result = await runScan(
    {
      repo,
      profile,
      scorer,
      // Live status so a scan is never silent: directory read, per-company, scoring.
      onProgress: (event) => log(formatProgress(event)),
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
  // Surface discovery warnings plus scorer fall-back warnings (e.g. no API key) after the summary.
  for (const warning of [...result.warnings, ...warnings]) {
    log(`  ! [${warning.source}] ${warning.message}`);
  }
}

export async function main(): Promise<void> {
  const command = parseCli(process.argv.slice(2));
  const log: Logger = (message) => console.log(message);

  if (command.kind === "help") {
    if (command.error) console.error(`Error: ${command.error}\n`);
    console.log(USAGE);
    process.exitCode = command.error ? 1 : 0;
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
    }
  } finally {
    repo.close();
  }
}

// Run only when executed as the CLI entrypoint, not when imported by tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

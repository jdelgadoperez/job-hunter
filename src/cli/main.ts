import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AIRTABLE_SHARE_SETTING } from "@app/discovery/sources/airtable";
import { PlaywrightSharedViewReader } from "@app/discovery/sources/airtable-playwright";
import type { Warning } from "@app/domain/types";
import { resolveScorer } from "@app/matching/resolve-scorer";
import type { SettingsReader } from "@app/matching/resolve-settings";
import { HttpFetcher } from "@app/net/fetcher";
import { PlaywrightRenderer } from "@app/net/playwright-renderer";
import { readResumeText } from "@app/profile/read-resume";
import { ensureDataDir, resolveDbPath } from "@app/runtime/paths";
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

const ANTHROPIC_KEY_SETTING = "anthropicApiKey";

/** Overlay the ANTHROPIC_API_KEY env var onto stored settings as a fallback. */
export function settingsWithEnvKey(repo: Repository): SettingsReader {
  return {
    getSetting: (key) => {
      const stored = repo.getSetting(key);
      if (stored !== undefined) return stored;
      if (key === ANTHROPIC_KEY_SETTING) return process.env.ANTHROPIC_API_KEY?.trim() || undefined;
      return undefined;
    },
  };
}

export async function runScanCommand(repo: Repository, log: Logger): Promise<void> {
  const profile = repo.getLatestProfile();
  if (!profile) {
    log("No profile yet. Run `job-hunter profile <resume-file>` first.");
    process.exitCode = 1;
    return;
  }
  const shareUrl = repo.getSetting(AIRTABLE_SHARE_SETTING);
  if (!shareUrl) {
    log(`No Airtable share URL set. Save it under the "${AIRTABLE_SHARE_SETTING}" setting first.`);
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

  await runScan(
    {
      repo,
      profile,
      scorer,
      discoverDeps: {
        fetcher: new HttpFetcher(),
        renderer: new PlaywrightRenderer(),
        sharedViewReader: new PlaywrightSharedViewReader(),
        shareUrl,
        trackedCompanies: repo.listTrackedCompanies(),
      },
    },
    log,
  );
  // Scorer fell-back warnings (e.g. no API key) surface after the scan summary.
  for (const warning of warnings) log(`  ! [${warning.source}] ${warning.message}`);
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

import { runScan } from "@app/cli/commands";
import { resolveShareUrl } from "@app/discovery/sources/airtable";
import { PlaywrightSharedViewReader } from "@app/discovery/sources/airtable-playwright";
import type { Warning } from "@app/domain/types";
import { resolveScorer } from "@app/matching/resolve-scorer";
import { settingsWithEnvKey } from "@app/matching/resolve-settings";
import { HttpFetcher } from "@app/net/fetcher";
import { PlaywrightRenderer } from "@app/net/playwright-renderer";
import type { Repository } from "@app/storage/repository";
import type { ScanRunner } from "./types";

/**
 * Production `ScanRunner` for the web server: the real discovery + scoring pipeline (browser +
 * live network), so it's integration-bound and smoke-only, like the Playwright wrappers it uses.
 * Mirrors the CLI's `scan` wiring. Missing preconditions throw, which the job manager records as
 * the job's error; structured progress (directory read, per-company, scoring) is forwarded through.
 */
export function createScanRunner(repo: Repository): ScanRunner {
  return async (onProgress) => {
    const profile = repo.getLatestProfile();
    if (!profile) throw new Error("No profile yet. Upload a resume first.");

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
        onProgress,
        discoverDeps: {
          fetcher: new HttpFetcher(),
          renderer: new PlaywrightRenderer(),
          sharedViewReader: new PlaywrightSharedViewReader(),
          shareUrl: resolveShareUrl(),
          trackedCompanies: repo.listTrackedCompanies(),
        },
      },
      // The job manager already captures structured progress; logger lines are redundant there.
      () => {},
    );

    return { count: result.count, warnings: [...warnings, ...result.warnings] };
  };
}

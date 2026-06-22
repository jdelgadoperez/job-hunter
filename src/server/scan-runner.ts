import { runScan } from "@app/cli/commands";
import { AIRTABLE_SHARE_SETTING } from "@app/discovery/sources/airtable";
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
 * Mirrors the CLI's `scan` wiring. Missing preconditions throw, which the SSE route surfaces as an
 * `error` event; per-line progress is forwarded from the engine's logger as `log` events.
 */
export function createScanRunner(repo: Repository): ScanRunner {
  return async (onProgress) => {
    onProgress({ phase: "start" });

    const profile = repo.getLatestProfile();
    if (!profile) throw new Error("No profile yet. Upload a resume first.");
    const shareUrl = repo.getSetting(AIRTABLE_SHARE_SETTING);
    if (!shareUrl) throw new Error("No Airtable share URL set. Save it in settings first.");

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
        discoverDeps: {
          fetcher: new HttpFetcher(),
          renderer: new PlaywrightRenderer(),
          sharedViewReader: new PlaywrightSharedViewReader(),
          shareUrl,
          trackedCompanies: repo.listTrackedCompanies(),
        },
      },
      (message) => onProgress({ phase: "log", message }),
    );

    const allWarnings = [...warnings, ...result.warnings];
    onProgress({ phase: "done", count: result.count, warnings: allWarnings });
    return { count: result.count, warnings: allWarnings };
  };
}

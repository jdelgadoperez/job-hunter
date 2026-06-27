import { runScan } from "@app/cli/commands";
import { style } from "@app/cli/style";
import { resolveShareUrl } from "@app/discovery/sources/airtable";
import { PlaywrightSharedViewReader } from "@app/discovery/sources/airtable-playwright";
import { formatProgress } from "@app/domain/scan-progress";
import { HeuristicScorer } from "@app/matching/heuristic-scorer";
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

    const dictionary = repo.getSkillDictionary();
    const scorer = new HeuristicScorer(dictionary.length > 0 ? dictionary : undefined);

    const result = await runScan(
      {
        repo,
        profile,
        scorer,
        // Update the job status snapshot AND echo each step to the server console, so progress is
        // followable in the `serve`/`dev` terminal (not just the dashboard).
        onProgress: (event) => {
          onProgress(event);
          console.log(`${style.dim("[scan]")} ${formatProgress(event)}`);
        },
        discoverDeps: {
          fetcher: new HttpFetcher(),
          renderer: new PlaywrightRenderer(),
          sharedViewReader: new PlaywrightSharedViewReader(),
          shareUrl: resolveShareUrl(),
          trackedCompanies: repo.listTrackedCompanies(),
        },
      },
      // Discovery warnings still reach the console for visibility.
      (message) => console.log(`${style.dim("[scan]")} ${message}`),
    );

    return { count: result.count, warnings: result.warnings };
  };
}

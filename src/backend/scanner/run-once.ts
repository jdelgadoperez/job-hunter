import { runSourcing, type SourcingOutcome } from "@app/cli/commands";
import type { DiscoverDeps } from "@app/discovery/discover";
import type { ScanStore } from "@app/discovery/scan-store";
import { LEAD_SOURCES, sharedOnly } from "@app/discovery/sources/registry";
import type { ScanProgressEvent } from "@app/domain/scan-progress";

/**
 * Run one full sourcing pass for the hosted worker: crawl the shared directory + aggregator sources
 * and write the deduped postings to the store. The worker uses the **full crawl** (no `feed` — it
 * *produces* the feed) and does **no scoring** (it has no resume). A thin wrapper over `runSourcing`
 * so the worker shares the exact pipeline the local scan uses. Designed to run once and exit, so a
 * scheduler (cron) can invoke it on an interval.
 *
 * Personal lead sources (`LeadSource.personal`, e.g. The Muse) are always dropped here, whatever the
 * caller passes: their leads are for a user's own local scans and must never reach the shared feed.
 */
export function runScannerOnce(deps: {
  store: ScanStore;
  discoverDeps: DiscoverDeps;
  onProgress?: (event: ScanProgressEvent) => void;
}): Promise<SourcingOutcome> {
  return runSourcing({
    repo: deps.store,
    discoverDeps: {
      ...deps.discoverDeps,
      sources: sharedOnly(deps.discoverDeps.sources ?? LEAD_SOURCES),
    },
    ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
  });
}

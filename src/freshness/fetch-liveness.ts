import { AshbyConnector } from "@app/discovery/connectors/ashby";
import { GreenhouseConnector } from "@app/discovery/connectors/greenhouse";
import { LeverConnector } from "@app/discovery/connectors/lever";
import type { AtsConnector } from "@app/discovery/connectors/types";
import type { JobPosting } from "@app/domain/types";
import type { Fetcher } from "@app/net/fetcher";
import type { LivenessSignal } from "./detect-liveness";

const ATS_CONNECTORS: Record<string, () => AtsConnector> = {
  greenhouse: () => new GreenhouseConnector(),
  lever: () => new LeverConnector(),
  ashby: () => new AshbyConnector(),
};

/**
 * Produce the `LivenessSignal` that Plan 1's `detectLiveness` consumes. For an
 * ATS-sourced posting we re-fetch the board feed and report whether the posting's
 * id is still present; for anything else (the browser fallback) we re-fetch its URL
 * and emit the raw HTTP signal so the detector can inspect status and body markers.
 */
export async function fetchLivenessSignal(
  posting: JobPosting,
  deps: { fetcher: Fetcher },
): Promise<LivenessSignal> {
  const makeConnector = ATS_CONNECTORS[posting.source];
  if (makeConnector) {
    const current = await makeConnector().fetchPostings(posting.company, deps.fetcher);
    return { kind: "ats-feed", postingPresent: current.some((p) => p.id === posting.id) };
  }

  const res = await deps.fetcher.fetch(posting.url);
  return {
    kind: "http",
    statusCode: res.statusCode,
    finalUrl: res.finalUrl,
    originalUrl: posting.url,
    bodyText: res.bodyText,
  };
}

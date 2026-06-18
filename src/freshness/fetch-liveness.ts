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
 * ATS-sourced posting we re-fetch the board feed and report whether the posting's id is
 * still present (and whether the feed was even reachable, so a transient failure reads
 * as "unknown" rather than "expired"); for anything else (the browser fallback) we
 * re-fetch its URL and emit the raw HTTP signal. Never throws — a failed re-fetch is
 * inconclusive, not proof of removal.
 */
export async function fetchLivenessSignal(
  posting: JobPosting,
  deps: { fetcher: Fetcher },
): Promise<LivenessSignal> {
  const makeConnector = ATS_CONNECTORS[posting.source];
  if (makeConnector) {
    const result = await makeConnector().fetchPostings(posting.company, deps.fetcher);
    if (!result.ok) {
      return { kind: "ats-feed", feedAvailable: false, postingPresent: false };
    }
    return {
      kind: "ats-feed",
      feedAvailable: true,
      postingPresent: result.postings.some((p) => p.id === posting.id),
    };
  }

  try {
    const res = await deps.fetcher.fetch(posting.url);
    return {
      kind: "http",
      statusCode: res.statusCode,
      finalUrl: res.finalUrl,
      originalUrl: posting.url,
      bodyText: res.bodyText,
    };
  } catch {
    // Timeout / invalid URL: statusCode 0 maps to "unknown" in detectLiveness.
    return {
      kind: "http",
      statusCode: 0,
      finalUrl: posting.url,
      originalUrl: posting.url,
      bodyText: "",
    };
  }
}

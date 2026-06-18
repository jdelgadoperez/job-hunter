import { AshbyConnector } from "./connectors/ashby";
import { GreenhouseConnector } from "./connectors/greenhouse";
import { LeverConnector } from "./connectors/lever";
import type { AtsConnector } from "./connectors/types";

export type ResolvedAts = { connector: AtsConnector; boardToken: string };

/**
 * Detect which ATS (if any) backs a careers URL and extract its board token.
 * Returns `null` when no known ATS matches, in which case the caller falls back
 * to the generic browser connector. Parses via `new URL()` host/path rather than
 * regex over the whole string.
 */
export function resolveAts(careersUrl: string): ResolvedAts | null {
  let parsed: URL;
  try {
    parsed = new URL(careersUrl);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const token = parsed.pathname.split("/").filter(Boolean)[0];
  if (!token) {
    return null;
  }

  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") {
    return { connector: new GreenhouseConnector(), boardToken: token };
  }
  if (host === "jobs.lever.co") {
    return { connector: new LeverConnector(), boardToken: token };
  }
  if (host === "jobs.ashbyhq.com") {
    return { connector: new AshbyConnector(), boardToken: token };
  }

  return null;
}

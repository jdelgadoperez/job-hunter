import {
  ashbyConnector,
  greenhouseConnector,
  leverConnector,
  recruiteeConnector,
  ripplingConnector,
  smartRecruitersConnector,
  workdayConnector,
} from "./connectors/registry";
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

  // Workday encodes tenant + site across the host and path, so it takes the whole careers URL as
  // its "board token" rather than a single path segment.
  if (host.endsWith(".myworkdayjobs.com")) {
    return { connector: workdayConnector, boardToken: careersUrl };
  }

  // Recruitee puts the board slug in the subdomain (`{slug}.recruitee.com`), not the path. The bare
  // apex (`recruitee.com`, `www.recruitee.com`, `support.recruitee.com`) is the platform site, not a
  // board, so require a non-reserved subdomain.
  if (host.endsWith(".recruitee.com")) {
    const subdomain = host.slice(0, -".recruitee.com".length);
    if (subdomain && subdomain !== "www" && subdomain !== "support") {
      return { connector: recruiteeConnector, boardToken: subdomain };
    }
    return null;
  }

  const token = parsed.pathname.split("/").filter(Boolean)[0];
  if (!token) {
    return null;
  }

  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") {
    return { connector: greenhouseConnector, boardToken: token };
  }
  if (host === "jobs.lever.co") {
    return { connector: leverConnector, boardToken: token };
  }
  if (host === "jobs.ashbyhq.com") {
    return { connector: ashbyConnector, boardToken: token };
  }
  if (host === "ats.rippling.com") {
    return { connector: ripplingConnector, boardToken: token };
  }
  if (host === "careers.smartrecruiters.com") {
    return { connector: smartRecruitersConnector, boardToken: token };
  }

  return null;
}

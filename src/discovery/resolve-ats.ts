import {
  ashbyConnector,
  bambooHrConnector,
  breezyConnector,
  greenhouseConnector,
  leverConnector,
  recruiteeConnector,
  ripplingConnector,
  smartRecruitersConnector,
  ukgConnector,
  workdayConnector,
} from "./connectors/registry";
import type { AtsConnector } from "./connectors/types";

export type ResolvedAts = { connector: AtsConnector; boardToken: string };

/** Subdomains that are the platform's own site, never a customer board. */
const RESERVED_SUBDOMAINS = new Set(["www", "support", "app", "help"]);

/**
 * For ATS platforms that put the board slug in the subdomain (`{slug}.recruitee.com`,
 * `{slug}.bamboohr.com`, `{slug}.breezy.hr`), extract the slug. Returns null for the apex
 * (no subdomain) and reserved subdomains, which are the platform site rather than a board.
 */
function subdomainBoardToken(host: string, apexSuffix: string): string | null {
  if (!host.endsWith(apexSuffix)) return null;
  const subdomain = host.slice(0, -apexSuffix.length);
  if (!subdomain || RESERVED_SUBDOMAINS.has(subdomain)) return null;
  return subdomain;
}

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

  // Workday and UKG encode the tenant (and more) across the host and path, so each takes the whole
  // careers URL as its "board token" rather than a single path segment.
  if (host.endsWith(".myworkdayjobs.com")) {
    return { connector: workdayConnector, boardToken: careersUrl };
  }
  if (host.endsWith(".ultipro.com")) {
    return { connector: ukgConnector, boardToken: careersUrl };
  }

  // Platforms that put the board slug in the subdomain (apex / reserved subdomains are the platform
  // site, not a board).
  const recruiteeToken = subdomainBoardToken(host, ".recruitee.com");
  if (recruiteeToken) return { connector: recruiteeConnector, boardToken: recruiteeToken };
  if (host.endsWith(".recruitee.com")) return null;

  const bambooHrToken = subdomainBoardToken(host, ".bamboohr.com");
  if (bambooHrToken) return { connector: bambooHrConnector, boardToken: bambooHrToken };
  if (host.endsWith(".bamboohr.com")) return null;

  const breezyToken = subdomainBoardToken(host, ".breezy.hr");
  if (breezyToken) return { connector: breezyConnector, boardToken: breezyToken };
  if (host.endsWith(".breezy.hr")) return null;

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

import type { JobPosting } from "@app/domain/types";

/**
 * Whether a posting's free-text location reads as remote-eligible. Connectors emit wildly varying
 * strings ("Remote - US", "Remote (United States)", "Anywhere"), so this is a generous regex over
 * the field. An unknown location (undefined / blank) is treated as remote so a missing field never
 * silently drops a posting from the remote-only flow.
 */
const REMOTE_SIGNAL = /\b(remote|anywhere|distributed|work from home|wfh)\b/i;

export function isRemote(location?: string): boolean {
  if (location === undefined || location.trim() === "") return true;
  return REMOTE_SIGNAL.test(location);
}

/**
 * Whether a posting is remote: trust a structured flag from the ATS when present, otherwise fall
 * back to the free-text location regex. One definition of "remote" for the badge, filter, and scorer.
 */
export function resolvePostingRemote(posting: Pick<JobPosting, "remote" | "location">): boolean {
  if (posting.remote !== undefined) return posting.remote;
  return isRemote(posting.location);
}

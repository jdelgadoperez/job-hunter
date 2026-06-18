import { createHash } from "node:crypto";

/**
 * Stable identifier for a job posting. Hashing `company + title + url` means the
 * same posting de-dupes across runs and across sources (e.g. discovered once via
 * the ATS feed and again via a JSON-LD careers page).
 */
export function makePostingId(parts: { company: string; title: string; url: string }): string {
  const canonical = `${parts.company} ${parts.title} ${parts.url}`.toLowerCase();
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

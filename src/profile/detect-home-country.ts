import { parseCountry } from "@app/matching/location-filter";

/**
 * Best-effort home-country detection for resume ingest. Never overwrites a user-provided
 * value — only fills in the setting when it's currently unset/blank.
 */
export function detectHomeCountry(
  resumeText: string,
  currentHomeCountry: string | undefined,
): string | undefined {
  if (currentHomeCountry !== undefined && currentHomeCountry.trim() !== "") return undefined;
  return parseCountry(resumeText);
}

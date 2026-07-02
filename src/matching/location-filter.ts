/**
 * Normalize a free-text location to a country label, or undefined when it can't be confidently
 * determined. Conservative by design: we only map high-confidence signals (explicit country name/
 * code, or a US/Canadian state-province) and return undefined otherwise so an unknown country is
 * never guessed and never silently dropped from an unfiltered list.
 */

import type { JobPosting } from "@app/domain/types";
import { resolvePostingRemote } from "./remote-filter";

// Canonical label per country, keyed by every alias we accept (lowercased). ISO-2 where it reads
// well in a dropdown ("US", "UK", "CA"), full name otherwise. Extend as new feeds appear.
const COUNTRY_ALIASES: Record<string, string> = {
  us: "US",
  usa: "US",
  "u.s.": "US",
  "u.s.a.": "US",
  "united states": "US",
  "united states of america": "US",
  uk: "UK",
  "u.k.": "UK",
  "united kingdom": "UK",
  "great britain": "UK",
  canada: "Canada",
  germany: "Germany",
  deutschland: "Germany",
  france: "France",
  india: "India",
  ireland: "Ireland",
  singapore: "Singapore",
  australia: "Australia",
  brazil: "Brazil",
  brasil: "Brazil",
  spain: "Spain",
  españa: "Spain",
  mexico: "Mexico",
  méxico: "Mexico",
  netherlands: "Netherlands",
  japan: "Japan",
  switzerland: "Switzerland",
  colombia: "Colombia",
  "united arab emirates": "United Arab Emirates",
  uae: "United Arab Emirates",
  türkiye: "Türkiye",
  turkey: "Türkiye",
};

// US: two-letter state codes AND full state names → US. (Lowercased.)
const US_STATES = new Set(
  (
    "al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj " +
    "nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc"
  ).split(" "),
);

// Full US state names (lowercased), mapped to US. Kept separate from the 2-letter codes so both
// "TX" and "Texas" resolve. "district of columbia" and "washington d.c." cover DC's full forms.
const US_STATE_NAMES = new Set([
  "alabama",
  "alaska",
  "arizona",
  "arkansas",
  "california",
  "colorado",
  "connecticut",
  "delaware",
  "florida",
  "georgia",
  "hawaii",
  "idaho",
  "illinois",
  "indiana",
  "iowa",
  "kansas",
  "kentucky",
  "louisiana",
  "maine",
  "maryland",
  "massachusetts",
  "michigan",
  "minnesota",
  "mississippi",
  "missouri",
  "montana",
  "nebraska",
  "nevada",
  "new hampshire",
  "new jersey",
  "new mexico",
  "new york",
  "north carolina",
  "north dakota",
  "ohio",
  "oklahoma",
  "oregon",
  "pennsylvania",
  "rhode island",
  "south carolina",
  "south dakota",
  "tennessee",
  "texas",
  "utah",
  "vermont",
  "virginia",
  "washington",
  "west virginia",
  "wisconsin",
  "wyoming",
  "district of columbia",
  "washington d.c.",
]);

// Canada: province/territory codes AND full names → Canada. (Lowercased.)
const CA_PROVINCES = new Set("ab bc mb nb nl ns nt nu on pe qc sk yt".split(" "));

const CA_PROVINCE_NAMES = new Set([
  "alberta",
  "british columbia",
  "manitoba",
  "new brunswick",
  "newfoundland and labrador",
  "nova scotia",
  "northwest territories",
  "nunavut",
  "ontario",
  "prince edward island",
  "quebec",
  "québec",
  "saskatchewan",
  "yukon",
]);

function normalizeToken(token: string): string {
  return token.trim().toLowerCase();
}

// Resolve a single normalized token/word against the alias + state/province sets. Returns the
// canonical country or undefined. Whole-string match only (callers pass already-split words), so
// "business" can never resolve via a substring of "us".
function resolveKey(key: string): string | undefined {
  const alias = COUNTRY_ALIASES[key];
  if (alias !== undefined) return alias;
  if (US_STATES.has(key) || US_STATE_NAMES.has(key)) return "US";
  if (CA_PROVINCES.has(key) || CA_PROVINCE_NAMES.has(key)) return "Canada";
  return undefined;
}

// Word-level variant of resolveKey, used only for the per-word scan inside a multi-word token.
// Deliberately excludes the 2-letter US_STATES/CA_PROVINCES code sets: those codes collide with
// common English words ("in", "or", "me", "la", "hi", "de", ...), so a phrase like "London or
// Paris" or "La Paz" must NOT resolve to a country just because one word happens to match a state
// code. Two-letter codes are only trustworthy as a whole delimited token (see resolveKey above),
// never as a word embedded in a longer phrase.
function resolveWordKey(key: string): string | undefined {
  const alias = COUNTRY_ALIASES[key];
  if (alias !== undefined) return alias;
  if (US_STATE_NAMES.has(key)) return "US";
  if (CA_PROVINCE_NAMES.has(key)) return "Canada";
  return undefined;
}

export function parseCountry(location?: string): string | undefined {
  if (location === undefined || location.trim() === "") return undefined;

  // Split on commas / parens / dashes / slashes / semicolons so "Remote - US" and
  // "Berlin, Germany" and "Australia; Singapore" all surface their parts.
  const tokens = location
    .split(/[,()\-–—/;]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // Check tokens from the end first — the country/region usually trails the city.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    if (token === undefined) continue;
    // 1) Whole-token match first, so multi-word aliases ("united arab emirates", "british columbia")
    //    and multi-word state names ("new york") resolve before word-splitting can break them apart.
    const wholeToken = resolveKey(normalizeToken(token));
    if (wholeToken !== undefined) return wholeToken;
    // 2) Otherwise scan each whitespace-separated word (still whole-word exact). Uses
    //    resolveWordKey, not resolveKey — see its comment for why 2-letter state/province codes
    //    are excluded here.
    const words = token.split(/\s+/).filter((w) => w.length > 0);
    for (const word of words) {
      const byWord = resolveWordKey(normalizeToken(word));
      if (byWord !== undefined) return byWord;
    }
  }
  return undefined;
}

/** The posting's country: the structured field when present, else parsed from its location text. */
export function resolvePostingCountry(
  posting: Pick<JobPosting, "country" | "location">,
): string | undefined {
  if (posting.country !== undefined) return posting.country;
  return parseCountry(posting.location);
}

/**
 * Whether a posting is a clear off-country non-starter given the user's home country: it has a
 * KNOWN country different from home AND is not remote. Unknown-country and remote roles are never
 * non-starters (never guessed away). Returns false when no home country is set (feature off).
 */
export function isOffCountryNonStarter(
  posting: Pick<JobPosting, "country" | "location" | "remote">,
  homeCountry: string | undefined,
): boolean {
  if (homeCountry === undefined || homeCountry.trim() === "") return false;
  const country = resolvePostingCountry(posting);
  if (country === undefined) return false; // unknown → keep
  if (country === homeCountry) return false; // in-country → keep
  return !resolvePostingRemote(posting); // foreign: non-starter only if not remote
}

/**
 * Normalize a free-text location to a country label, or undefined when it can't be confidently
 * determined. Conservative by design: we only map high-confidence signals (explicit country name/
 * code, or a US/Canadian state-province) and return undefined otherwise so an unknown country is
 * never guessed and never silently dropped from an unfiltered list.
 */

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

export function parseCountry(location?: string): string | undefined {
  if (location === undefined || location.trim() === "") return undefined;

  // Split on commas / parens / dashes so "Remote - US" and "Berlin, Germany" both surface the tail.
  const tokens = location
    .split(/[,()\-–—/]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // Check tokens from the end first — the country/region usually trails the city.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    if (token === undefined) continue;
    const key = normalizeToken(token);
    const alias = COUNTRY_ALIASES[key];
    if (alias !== undefined) return alias;
    if (US_STATES.has(key) || US_STATE_NAMES.has(key)) return "US";
    if (CA_PROVINCES.has(key) || CA_PROVINCE_NAMES.has(key)) return "Canada";
  }
  return undefined;
}

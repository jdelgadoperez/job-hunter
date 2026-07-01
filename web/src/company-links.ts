import type { JobPosting } from "./api";

/** A single research link shown on a match card. `key` is stable for React keys and tests. */
export type CompanyLink = {
  key: "website" | "glassdoor" | "linkedin" | "crunchbase";
  label: string;
  href: string;
};

// Trailing legal/HQ tokens that add noise to a company search rather than identifying it. Kept
// deliberately narrow: `corp`/`co` are excluded because they're frequently part of the real name
// (e.g. "Acme Corp"), whereas `inc`/`llc`/`ltd`/`gmbh`/`hq` are almost always boilerplate.
const NOISE_SUFFIXES = new Set(["inc", "llc", "ltd", "hq", "gmbh"]);

/**
 * A human-readable company name for display and search queries. `posting.company` is often an ATS
 * board token (e.g. `acme-corp`) rather than a clean name, so we de-slug it, drop trailing
 * legal/HQ suffixes, collapse whitespace, and title-case. This is display/query-only — it never
 * mutates the stored `company`, which must stay a slug for ATS liveness re-fetching.
 */
export function companyDisplayName(raw: string): string {
  const words = raw.trim().replace(/[-_]+/g, " ").replace(/\s+/g, " ").split(" ").filter(Boolean);

  while (words.length > 1) {
    const last = words[words.length - 1]?.toLowerCase().replace(/[.,]/g, "") ?? "";
    if (NOISE_SUFFIXES.has(last)) words.pop();
    else break;
  }

  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

/** The origin (`https://host`) of a URL with a leading `www.` stripped, or null if unparseable. */
function siteOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname.replace(/^www\./, "")}`;
  } catch {
    return null;
  }
}

const ddgSearch = (query: string): string =>
  `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;

/**
 * Research links for the company behind a posting — website, Glassdoor, LinkedIn, Crunchbase.
 * Tier 1: every link is a deterministic, client-side URL (a scoped search where we can't know the
 * exact page), so this needs no backend and never fetches. For browser-sourced postings the
 * posting URL is the company's own careers page, so its origin is a good direct website link;
 * otherwise the website falls back to a search like the rest.
 */
export function companyLinks(posting: JobPosting): CompanyLink[] {
  const name = companyDisplayName(posting.company);
  const website =
    posting.source === "browser" ? (siteOrigin(posting.url) ?? ddgSearch(name)) : ddgSearch(name);

  return [
    { key: "website", label: "Website", href: website },
    {
      key: "glassdoor",
      label: "Glassdoor",
      href: `https://www.glassdoor.com/Search/results.htm?keyword=${encodeURIComponent(name)}`,
    },
    {
      key: "linkedin",
      label: "LinkedIn",
      href: `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(name)}`,
    },
    { key: "crunchbase", label: "Crunchbase", href: ddgSearch(`${name} site:crunchbase.com`) },
  ];
}

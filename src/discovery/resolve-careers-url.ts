import type { Fetcher } from "@app/net/fetcher";
import {
  ashbyConnector,
  bambooHrConnector,
  breezyConnector,
  greenhouseConnector,
  leverConnector,
  recruiteeConnector,
  smartRecruitersConnector,
  workableConnector,
} from "./connectors/registry";
import type { AtsConnector } from "./connectors/types";

/**
 * Resolve a company we'd otherwise skip (its directory careers URL is a LinkedIn/Indeed/Glassdoor
 * page — see `unscrapable.ts`) to its OWN public ATS board, so the existing connectors can scrape it
 * within terms instead of us scraping the aggregator.
 *
 * The technique is a **name-derived slug probe**: derive candidate board slugs from the company name
 * and probe the slug-keyed ATS public APIs by simply calling the existing connectors with each
 * candidate token. A connector that returns a live board (≥1 posting) is a hit. This reuses the
 * connectors verbatim, needs no API key/search engine/browser, and is fully offline-unit-testable
 * with `FakeFetcher` — the connectors never throw (they degrade to `{ ok: false }`), and this never
 * throws either.
 *
 * PRECISION CAVEAT: ATS slugs collide across unrelated companies (a short slug like `base` may hit a
 * different employer's board). The most-specific candidate (the full name concatenated) is high
 * confidence; looser first-word candidates are not. `candidateRank` is surfaced so callers can weigh
 * this. Before this is wired into the scan to auto-rewrite a lead's careers URL, the guard must be
 * hardened with an INDEPENDENT identity signal (e.g. fingerprint the company homepage and confirm it
 * embeds the same board) — the diagnostic (`scripts/probe-unscrapable.ts`) exists to measure the raw
 * precision first.
 */

/** Board slugs shorter than this are too generic to probe (avoid 1–2 char collisions). */
const MIN_SLUG_LENGTH = 3;
/** A first-word-only candidate is only worth probing when it's at least this long (recall vs noise). */
const MIN_FIRST_WORD_LENGTH = 5;

/**
 * Trailing legal/HQ tokens that are boilerplate rather than identity. Mirrors the narrow set in
 * `web/src/company-links.ts` (`corp`/`co` deliberately excluded — often part of the real name).
 */
const NOISE_SUFFIXES = new Set(["inc", "llc", "ltd", "hq", "gmbh"]);

/**
 * Derive candidate ATS board slugs from a company display name, most-specific first. Pure and
 * side-effect-free. E.g. `"Khan Academy"` → `["khanacademy", "khan-academy"]`; a leading article and
 * trailing legal noise are dropped, punctuation is stripped, `&` becomes `and`.
 */
export function candidateSlugs(companyName: string): string[] {
  const cleaned = companyName
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let words = cleaned.split(" ").filter(Boolean);
  // Strip a leading article ("the LEGO Group" → "lego group").
  if (words.length > 1 && words[0] === "the") words = words.slice(1);
  // Strip trailing legal/HQ boilerplate ("Acme Inc" → "acme").
  while (words.length > 1 && NOISE_SUFFIXES.has(words[words.length - 1] ?? "")) {
    words = words.slice(0, -1);
  }
  if (words.length === 0) return [];

  const variants = [words.join(""), words.join("-")];
  // A first-word-only slug catches boards named after the lead word ("LEGO Group" → "lego"), but it
  // is the lowest-confidence candidate, so it's last and length-gated.
  if (words.length > 1 && (words[0]?.length ?? 0) >= MIN_FIRST_WORD_LENGTH) {
    variants.push(words[0] ?? "");
  }

  const seen = new Set<string>();
  const slugs: string[] = [];
  for (const variant of variants) {
    if (variant.length < MIN_SLUG_LENGTH) continue;
    if (!/^[a-z0-9-]+$/.test(variant)) continue;
    if (seen.has(variant)) continue;
    seen.add(variant);
    slugs.push(variant);
  }
  return slugs;
}

/** A slug-keyed ATS connector paired with a builder for its canonical careers URL. */
export type SlugConnector = { connector: AtsConnector; boardUrl: (slug: string) => string };

/**
 * The slug-keyed ATS connectors, each with a builder that turns a board token back into a canonical
 * careers URL. Every URL here round-trips through `resolveAts` back to the same connector (asserted
 * in the tests), so a resolved board can be handed straight to the existing pipeline. Workday and UKG
 * are intentionally absent — their board token is a whole tenant URL, not a name-derivable slug.
 */
export const SLUG_CONNECTORS: SlugConnector[] = [
  { connector: greenhouseConnector, boardUrl: (s) => `https://boards.greenhouse.io/${s}` },
  { connector: leverConnector, boardUrl: (s) => `https://jobs.lever.co/${s}` },
  { connector: ashbyConnector, boardUrl: (s) => `https://jobs.ashbyhq.com/${s}` },
  {
    connector: smartRecruitersConnector,
    boardUrl: (s) => `https://careers.smartrecruiters.com/${s}`,
  },
  { connector: recruiteeConnector, boardUrl: (s) => `https://${s}.recruitee.com/` },
  { connector: bambooHrConnector, boardUrl: (s) => `https://${s}.bamboohr.com/careers` },
  { connector: breezyConnector, boardUrl: (s) => `https://${s}.breezy.hr/` },
  { connector: workableConnector, boardUrl: (s) => `https://apply.workable.com/${s}/` },
];

export type ResolvedBoard = {
  /** The `source` of the connector that matched (e.g. `greenhouse`). */
  platform: string;
  /** The candidate slug that resolved to a live board. */
  boardToken: string;
  /** Canonical careers URL for the board; round-trips through `resolveAts` to `platform`. */
  boardUrl: string;
  /** How many open postings the board returned (a liveness/quality signal). */
  postingCount: number;
  /** First posting, purely so callers/diagnostics can eyeball whether the match is the right company. */
  sample?: { title: string; url: string };
  /** Index of the matched slug in `candidateSlugs` — 0 is the highest-confidence (full-name) slug. */
  candidateRank: number;
};

/**
 * Try to resolve a company name to a live ATS board by probing candidate slugs against the slug-keyed
 * connectors, most-specific slug first. Returns the first live board (≥1 posting), or `null` if none
 * matched. Never throws: a connector failure on one probe just moves on to the next.
 *
 * The `fetcher` is injected so this is driven by `FakeFetcher` in unit tests and the real
 * `HttpFetcher` in the diagnostic/scan. `connectors` and `maxSlugs` are injectable for tests.
 */
export async function resolveCareersUrl(
  companyName: string,
  fetcher: Fetcher,
  opts: { connectors?: SlugConnector[]; maxSlugs?: number } = {},
): Promise<ResolvedBoard | null> {
  const connectors = opts.connectors ?? SLUG_CONNECTORS;
  const slugs = candidateSlugs(companyName);
  const maxSlugs = Math.min(slugs.length, opts.maxSlugs ?? slugs.length);

  for (let rank = 0; rank < maxSlugs; rank += 1) {
    const slug = slugs[rank] ?? "";
    for (const { connector, boardUrl } of connectors) {
      let result: Awaited<ReturnType<AtsConnector["fetchPostings"]>>;
      try {
        result = await connector.fetchPostings(slug, fetcher);
      } catch {
        // Connectors are contracted not to throw, but never let an unexpected throw abort the probe.
        continue;
      }
      if (result.ok && result.postings.length > 0) {
        const first = result.postings[0];
        return {
          platform: connector.source,
          boardToken: slug,
          boardUrl: boardUrl(slug),
          postingCount: result.postings.length,
          ...(first ? { sample: { title: first.title, url: first.url } } : {}),
          candidateRank: rank,
        };
      }
    }
  }
  return null;
}

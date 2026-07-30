import pLimit from "p-limit";
import { type ResolvedBoard, resolveCareersUrl } from "../src/discovery/resolve-careers-url";
import { airtableRowsToLeads, resolveShareUrl } from "../src/discovery/sources/airtable";
import { PlaywrightSharedViewReader } from "../src/discovery/sources/airtable-playwright";
import { isUnscrapableHost } from "../src/discovery/unscrapable";
import { hostnameOf } from "../src/domain/normalize";
import { HttpFetcher } from "../src/net/fetcher";

/**
 * Opt-in diagnostic: for every directory company we currently SKIP because its careers URL is a
 * LinkedIn/Indeed/Glassdoor page (`unscrapable.ts`), try to resolve the company to its own public ATS
 * board by name-derived slug probing (`resolveCareersUrl`) and report how many are recoverable, via
 * which ATS, and how confident the match is. This sizes the payoff of wiring the resolver into the
 * scan BEFORE changing scan behavior — the same size-it-first approach `probe-custom-domains.ts` took
 * for the browser-fallback domains.
 *
 *   npm run analyze:unscrapable                       # probe all skipped companies
 *   PROBE_LIMIT=50 npm run analyze:unscrapable        # cap the count for a quick sample
 *
 * Drives a real Chromium against the public Airtable share (like smoke:airtable) to read the
 * directory, then makes a handful of light HTTP GETs per company against public ATS APIs. Needs
 * network + `npx playwright install chromium`. This script does NOT change scan behavior.
 *
 * PRECISION: rank-0 hits use the full-name slug (high confidence); rank>0 hits use a looser slug and
 * should be treated as candidates to verify, not truths — see the caveat in `resolve-careers-url.ts`.
 * The per-company sample line (title + URL) is printed so precision can be eyeballed.
 */

const PROBE_CONCURRENCY = 6;
const PROBE_TIMEOUT_MS = 12_000;

type ProbeResult = { company: string; careersUrl: string; board: ResolvedBoard | null };

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sorted(counts: Map<string, number>): [string, number][] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function pct(n: number, total: number): string {
  return total === 0 ? "0%" : `${Math.round((100 * n) / total)}%`;
}

async function main(): Promise<void> {
  const shareUrl = resolveShareUrl();
  console.log(`Probing LinkedIn/Indeed-skipped companies in: ${shareUrl}\n`);

  const raw = await new PlaywrightSharedViewReader().read(shareUrl);
  const { leads, warning } = airtableRowsToLeads(raw);
  if (warning) console.warn(`! mapping warning: ${warning}`);

  const skipped = leads.filter((lead) => isUnscrapableHost(lead.careersUrl));

  const limit = process.env.PROBE_LIMIT ? Number.parseInt(process.env.PROBE_LIMIT, 10) : undefined;
  const targets = limit ? skipped.slice(0, limit) : skipped;

  console.log(`Total companies: ${leads.length}`);
  console.log(
    `Skipped (LinkedIn/Indeed/Glassdoor): ${skipped.length} (${pct(skipped.length, leads.length)} of directory)`,
  );
  if (limit) console.log(`Sampling the first ${targets.length} (PROBE_LIMIT=${limit})`);
  console.log(`Probing ${targets.length} companies (concurrency ${PROBE_CONCURRENCY})…\n`);

  const fetcher = new HttpFetcher(PROBE_TIMEOUT_MS);
  const run = pLimit(PROBE_CONCURRENCY);
  let done = 0;
  const results = await Promise.all(
    targets.map((lead) =>
      run(async (): Promise<ProbeResult> => {
        const board = await resolveCareersUrl(lead.company, fetcher);
        done += 1;
        if (done % 25 === 0) console.log(`  …${done}/${targets.length}`);
        return { company: lead.company, careersUrl: lead.careersUrl, board };
      }),
    ),
  );

  report(results, targets.length);
}

function report(results: ProbeResult[], probed: number): void {
  const resolvedByPlatform = new Map<string, number>();
  const highConfidence: ProbeResult[] = [];
  const lowConfidence: ProbeResult[] = [];

  for (const result of results) {
    if (!result.board) continue;
    increment(resolvedByPlatform, result.board.platform);
    (result.board.candidateRank === 0 ? highConfidence : lowConfidence).push(result);
  }

  const resolvedTotal = highConfidence.length + lowConfidence.length;

  console.log(`\n${"=".repeat(64)}`);
  console.log(`Probed ${probed} skipped companies.\n`);

  console.log(
    `Resolved to an existing ATS connector: ${resolvedTotal} (${pct(resolvedTotal, probed)})`,
  );
  console.log(
    `  high confidence (exact-name slug):   ${highConfidence.length} (${pct(highConfidence.length, probed)})`,
  );
  console.log(
    `  low confidence (looser slug — verify): ${lowConfidence.length} (${pct(lowConfidence.length, probed)})`,
  );
  console.log(`\n  by platform:`);
  for (const [platform, count] of sorted(resolvedByPlatform)) {
    console.log(`      ${platform.padEnd(20)} ${count}`);
  }

  console.log(
    `\nNo confident match (stays skipped): ${probed - resolvedTotal} (${pct(probed - resolvedTotal, probed)})`,
  );

  printSamples("High-confidence matches (rank 0)", highConfidence);
  printSamples("Low-confidence matches (rank > 0 — eyeball these)", lowConfidence);

  console.log(`\n${"=".repeat(64)}`);
  console.log(
    "Next step: if precision looks good, wire `resolveCareersUrl` into discover.ts behind",
  );
  console.log(
    "an opt-in flag (rewrite lead.careersUrl before the crawl). Harden the guard for the",
  );
  console.log("low-confidence bucket with an independent identity check before auto-rewriting.");
}

function printSamples(heading: string, results: ProbeResult[]): void {
  if (results.length === 0) return;
  console.log(`\n${heading}:`);
  for (const { company, careersUrl, board } of results) {
    if (!board) continue;
    const sample = board.sample ? ` — e.g. "${board.sample.title}"` : "";
    console.log(
      `  ${company.padEnd(32)} → ${board.boardUrl}  [${board.postingCount} jobs, was ${hostnameOf(careersUrl)}]${sample}`,
    );
  }
}

main().catch((error) => {
  console.error("Probe failed:", error);
  process.exitCode = 1;
});

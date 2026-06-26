import pLimit from "p-limit";
import { detectAtsFingerprint } from "../src/discovery/detect-ats-fingerprint";
import { resolveAts } from "../src/discovery/resolve-ats";
import { airtableRowsToLeads, resolveShareUrl } from "../src/discovery/sources/airtable";
import { PlaywrightSharedViewReader } from "../src/discovery/sources/airtable-playwright";
import { isUnscrapableHost } from "../src/discovery/unscrapable";
import { hostnameOf } from "../src/domain/normalize";
import { HttpFetcher } from "../src/net/fetcher";
/**
 * Opt-in diagnostic (issue #39): for every custom/vanity careers domain that a scan would currently
 * send to the slow Playwright browser fallback, live-fetch the page and fingerprint which ATS (if
 * any) backs it. Aggregates the ~480 fallback domains into three buckets so we can size the work:
 *
 *   - resolves to an ATS we ALREADY have a connector for (just needs an embed-follow resolve step)
 *   - a known ATS platform we don't have a connector for yet (a new-connector candidate)
 *   - genuinely bespoke (no recognizable ATS — stays on the browser fallback)
 *
 *   npm run analyze:custom-domains            # probe all custom domains
 *   PROBE_LIMIT=50 npm run analyze:custom-domains   # cap the count for a quick sample
 *
 * Drives a real Chromium against the public Airtable share (like smoke:airtable) and then makes one
 * light HTTP GET per custom domain, so it needs network + `npx playwright install chromium`.
 * This script does NOT change scan behavior — it only sizes the opportunity.
 */

const PROBE_CONCURRENCY = 8;
const PROBE_TIMEOUT_MS = 12_000;

type ProbeOutcome =
  | { kind: "existing-connector"; platform: string; signal: string }
  | { kind: "new-platform"; platform: string; signal: string }
  | { kind: "json-ld"; signal: string }
  | { kind: "bespoke" }
  | { kind: "error"; reason: string };

type ProbeResult = { company: string; careersUrl: string; host: string; outcome: ProbeOutcome };

async function probe(careersUrl: string, fetcher: HttpFetcher): Promise<ProbeOutcome> {
  let res: Awaited<ReturnType<HttpFetcher["fetch"]>>;
  try {
    res = await fetcher.fetch(careersUrl);
  } catch (error) {
    return { kind: "error", reason: error instanceof Error ? error.message : String(error) };
  }
  if (res.statusCode >= 400) {
    return { kind: "error", reason: `HTTP ${res.statusCode}` };
  }

  const match = detectAtsFingerprint(res.finalUrl, res.bodyText);
  if (!match) return { kind: "bespoke" };
  if (match.platform === "json-ld") return { kind: "json-ld", signal: match.signal };
  if (match.connectorSource) {
    return { kind: "existing-connector", platform: match.connectorSource, signal: match.signal };
  }
  return { kind: "new-platform", platform: match.platform, signal: match.signal };
}

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
  console.log(`Probing custom careers domains in: ${shareUrl}\n`);

  const raw = await new PlaywrightSharedViewReader().read(shareUrl);
  const { leads, warning } = airtableRowsToLeads(raw);
  if (warning) console.warn(`! mapping warning: ${warning}`);

  // The browser-fallback set: leads with no known ATS host and not on an unscrapable host.
  const custom = leads.filter(
    (lead) => !resolveAts(lead.careersUrl) && !isUnscrapableHost(lead.careersUrl),
  );

  const limit = process.env.PROBE_LIMIT ? Number.parseInt(process.env.PROBE_LIMIT, 10) : undefined;
  const targets = limit ? custom.slice(0, limit) : custom;

  console.log(`Total companies: ${leads.length}`);
  console.log(
    `Custom/vanity domains (browser fallback): ${custom.length} (${pct(custom.length, leads.length)} of directory)`,
  );
  if (limit) console.log(`Sampling the first ${targets.length} (PROBE_LIMIT=${limit})`);
  console.log(`Probing ${targets.length} domains (concurrency ${PROBE_CONCURRENCY})…\n`);

  const fetcher = new HttpFetcher(PROBE_TIMEOUT_MS);
  const run = pLimit(PROBE_CONCURRENCY);
  let done = 0;
  const results = await Promise.all(
    targets.map((lead) =>
      run(async (): Promise<ProbeResult> => {
        const outcome = await probe(lead.careersUrl, fetcher);
        done += 1;
        if (done % 25 === 0) console.log(`  …${done}/${targets.length}`);
        return {
          company: lead.company,
          careersUrl: lead.careersUrl,
          host: hostnameOf(lead.careersUrl),
          outcome,
        };
      }),
    ),
  );

  report(results, targets.length);
}

function report(results: ProbeResult[], probed: number): void {
  const existingByConnector = new Map<string, number>();
  const newByPlatform = new Map<string, number>();
  const errorsByReason = new Map<string, number>();
  let jsonLd = 0;
  let bespoke = 0;

  for (const { outcome } of results) {
    switch (outcome.kind) {
      case "existing-connector":
        increment(existingByConnector, outcome.platform);
        break;
      case "new-platform":
        increment(newByPlatform, outcome.platform);
        break;
      case "json-ld":
        jsonLd += 1;
        break;
      case "bespoke":
        bespoke += 1;
        break;
      case "error":
        increment(errorsByReason, outcome.reason);
        break;
    }
  }

  const existingTotal = [...existingByConnector.values()].reduce((a, b) => a + b, 0);
  const newTotal = [...newByPlatform.values()].reduce((a, b) => a + b, 0);
  const errorTotal = [...errorsByReason.values()].reduce((a, b) => a + b, 0);

  console.log(`\n${"=".repeat(64)}`);
  console.log(`Probed ${probed} custom domains. Buckets:\n`);

  console.log(
    `[1] Resolves to an EXISTING connector (needs an embed-follow resolve step): ${existingTotal} (${pct(existingTotal, probed)})`,
  );
  for (const [platform, count] of sorted(existingByConnector)) {
    console.log(`      ${platform.padEnd(20)} ${count}`);
  }

  console.log(
    `\n[2] Known ATS platform with NO connector yet (new-connector candidate): ${newTotal} (${pct(newTotal, probed)})`,
  );
  for (const [platform, count] of sorted(newByPlatform)) {
    console.log(`      ${platform.padEnd(20)} ${count}`);
  }

  console.log(
    `\n[3] Bespoke / unrecognized (stays on the browser fallback): ${bespoke} (${pct(bespoke, probed)})`,
  );
  console.log(`      of which emit a JSON-LD JobPosting (scrapable, ATS unknown): ${jsonLd}`);

  console.log(
    `\n[!] Probe errors (timeout / HTTP error / blocked): ${errorTotal} (${pct(errorTotal, probed)})`,
  );
  for (const [reason, count] of sorted(errorsByReason).slice(0, 10)) {
    console.log(`      ${reason.padEnd(28)} ${count}`);
  }

  console.log(`\n${"=".repeat(64)}`);
  console.log("Recommendation inputs:");
  console.log(
    "  • Bucket [1] is the cheapest win — an embed-follow resolve step reuses existing connectors.",
  );
  console.log("  • Bucket [2] sizes which NEW connector would clear the most fallback domains.");
  console.log("  • Bucket [3] is the residual that stays on Playwright regardless.");
}

main().catch((error) => {
  console.error("Probe failed:", error);
  process.exitCode = 1;
});

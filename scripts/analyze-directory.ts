import { resolveAts } from "../src/discovery/resolve-ats";
import { airtableRowsToLeads, resolveShareUrl } from "../src/discovery/sources/airtable";
import { PlaywrightSharedViewReader } from "../src/discovery/sources/airtable-playwright";
/**
 * Opt-in diagnostic: classify the live directory's careers URLs by how a scan would fetch them —
 * fast ATS connectors (Greenhouse/Lever/Ashby) vs. the slow Playwright browser fallback — and show
 * which platforms dominate the fallback. Use it to size scan-performance work.
 *
 *   npm run analyze:directory
 *
 * Drives a real Chromium against the public Airtable share (like smoke:airtable), so it needs
 * network + `npx playwright install chromium chromium-headless-shell`.
 */
import { hostnameOf } from "../src/domain/normalize";

/** Group hosts under the platform that matters for a scan (so e.g. all Workday tenants collapse). */
function platformOf(host: string): string {
  if (host.endsWith("myworkdayjobs.com") || host.endsWith("workday.com")) return "workday";
  if (host.endsWith("linkedin.com")) return "linkedin";
  if (host.endsWith("greenhouse.io")) return "greenhouse (page, not API)";
  if (host.endsWith("lever.co")) return "lever (page, not API)";
  if (host.endsWith("ashbyhq.com")) return "ashby (page, not API)";
  if (host.endsWith("indeed.com")) return "indeed";
  return host;
}

function sorted(counts: Map<string, number>): [string, number][] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

async function main(): Promise<void> {
  const shareUrl = resolveShareUrl();
  console.log(`Analyzing directory: ${shareUrl}\n`);

  const raw = await new PlaywrightSharedViewReader().read(shareUrl);
  const { leads, warning } = airtableRowsToLeads(raw);
  if (warning) console.warn(`! mapping warning: ${warning}`);

  const ats = new Map<string, number>();
  const fallback = new Map<string, number>();
  for (const lead of leads) {
    const resolved = resolveAts(lead.careersUrl);
    if (resolved) {
      ats.set(resolved.connector.source, (ats.get(resolved.connector.source) ?? 0) + 1);
    } else {
      const platform = platformOf(hostnameOf(lead.careersUrl));
      fallback.set(platform, (fallback.get(platform) ?? 0) + 1);
    }
  }

  const atsTotal = [...ats.values()].reduce((a, b) => a + b, 0);
  const fallbackTotal = [...fallback.values()].reduce((a, b) => a + b, 0);

  console.log(`Total companies: ${leads.length}`);
  console.log(`\nFast ATS API connectors: ${atsTotal} (${pct(atsTotal, leads.length)})`);
  for (const [source, count] of sorted(ats)) console.log(`  ${source.padEnd(28)} ${count}`);

  console.log(
    `\nBrowser fallback (one Playwright load each): ${fallbackTotal} (${pct(fallbackTotal, leads.length)})`,
  );
  for (const [platform, count] of sorted(fallback).slice(0, 20)) {
    console.log(`  ${platform.padEnd(40)} ${count}`);
  }
  const shownDistinct = sorted(fallback).length;
  if (shownDistinct > 20) console.log(`  …and ${shownDistinct - 20} more distinct hosts`);
}

function pct(n: number, total: number): string {
  return total === 0 ? "0%" : `${Math.round((100 * n) / total)}%`;
}

main().catch((error) => {
  console.error("Analysis failed:", error);
  process.exitCode = 1;
});

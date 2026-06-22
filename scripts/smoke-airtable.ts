/**
 * Opt-in, manual smoke test for the live Airtable shared-view reader. NOT part of `npm test`.
 *
 *   AIRTABLE_SHARE_URL="https://airtable.com/appX/shrX/tblX" npm run smoke:airtable
 *
 * Drives a real Chromium (Playwright) against the public Airtable share, captures the embed's
 * own `readSharedViewData` response, prints the mapped company leads, and writes the raw response
 * to `src/discovery/sources/__fixtures__/airtable-shared-view.json` so the unit tests run against
 * a REAL capture instead of the synthetic placeholder. Requires `npx playwright install chromium`.
 *
 * Defaults to stillhiring's published share if AIRTABLE_SHARE_URL is unset.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { airtableRowsToLeads, resolveShareUrl } from "../src/discovery/sources/airtable";
import { PlaywrightSharedViewReader } from "../src/discovery/sources/airtable-playwright";

const FIXTURE_PATH = join(
  process.cwd(),
  "src/discovery/sources/__fixtures__/airtable-shared-view.json",
);

async function main(): Promise<void> {
  const shareUrl = resolveShareUrl();
  console.log(`Reading Airtable shared view:\n  ${shareUrl}\n`);

  const reader = new PlaywrightSharedViewReader();
  const raw = await reader.read(shareUrl);

  const { leads, warning } = airtableRowsToLeads(raw);
  if (warning) console.warn(`! mapping warning: ${warning}`);
  console.log(`Mapped ${leads.length} lead(s):`);
  for (const lead of leads.slice(0, 20)) {
    console.log(`  - ${lead.company} → ${lead.careersUrl}`);
  }
  if (leads.length > 20) console.log(`  … and ${leads.length - 20} more`);

  if (process.env.WRITE_FIXTURE === "1") {
    writeFileSync(FIXTURE_PATH, `${JSON.stringify(raw, null, 2)}\n`);
    console.log(`\nWrote real capture to ${FIXTURE_PATH} (re-run the unit tests to validate).`);
  } else {
    console.log("\nSet WRITE_FIXTURE=1 to overwrite the test fixture with this real capture.");
  }
}

main().catch((error) => {
  console.error("Smoke test failed:", error);
  process.exitCode = 1;
});

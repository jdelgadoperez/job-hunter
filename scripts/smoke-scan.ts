/**
 * Opt-in, manual smoke test for a full live `scan`. NOT part of `npm test`.
 *
 *   ANTHROPIC_API_KEY=sk-... RESUME=/path/to/resume.pdf npm run smoke:scan
 *
 * Runs the real engine end to end against a throwaway temp database: builds a profile from a
 * resume, discovers companies (live Playwright Airtable read of the community directory + ATS
 * connectors), scores with the real LLM (or the heuristic fallback if no key), and prints the
 * ranked matches. Set AIRTABLE_SHARE_URL to override the directory. Touches the network and a
 * real browser, so it is excluded from CI. Requires `npx playwright install chromium chromium-headless-shell`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveShareUrl } from "../src/discovery/sources/airtable";
import { PlaywrightSharedViewReader } from "../src/discovery/sources/airtable-playwright";
import type { Warning } from "../src/domain/types";
import { resolveScorer } from "../src/matching/resolve-scorer";
import { HttpFetcher } from "../src/net/fetcher";
import { PlaywrightRenderer } from "../src/net/playwright-renderer";
import { buildProfile } from "../src/profile/build-profile";
import { readResumeText } from "../src/profile/read-resume";
import { Repository } from "../src/storage/repository";

async function main(): Promise<void> {
  const resumePath = process.env.RESUME?.trim();
  if (!resumePath) {
    console.error("Set RESUME to run the scan smoke test.");
    process.exitCode = 1;
    return;
  }
  const shareUrl = resolveShareUrl();

  const dir = mkdtempSync(join(tmpdir(), "jh-scan-"));
  const repo = new Repository(join(dir, "jobhunter.db"));
  try {
    const profile = buildProfile({ resumeText: await readResumeText(resumePath) });
    repo.saveProfile(profile);
    console.log(`Profile: ${profile.skills.length} skill(s).`);

    const warnings: Warning[] = [];
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (apiKey) repo.setSetting("anthropicApiKey", apiKey);
    const scorer = resolveScorer({ settings: repo, onWarning: (w) => warnings.push(w) });

    const { discover } = await import("../src/discovery/discover");
    const { postings, warnings: discoverWarnings } = await discover({
      fetcher: new HttpFetcher(),
      renderer: new PlaywrightRenderer(),
      sharedViewReader: new PlaywrightSharedViewReader(),
      shareUrl,
      trackedCompanies: repo.listTrackedCompanies(),
    });

    const scored = [];
    for (const posting of postings) {
      scored.push({ posting, result: await scorer.score(profile, posting) });
    }
    scored.sort((a, b) => b.result.score - a.result.score);

    console.log(`\nTop matches (${scored.length} postings):`);
    for (const { posting, result } of scored.slice(0, 15)) {
      console.log(`  [${result.score}] ${posting.title} — ${posting.company}`);
    }
    for (const w of [...discoverWarnings, ...warnings]) {
      console.log(`  ! [${w.source}] ${w.message}`);
    }
    console.log(`\n(Directory: ${shareUrl}; temp DB at ${dir})`);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("Smoke test failed:", error);
  process.exitCode = 1;
});

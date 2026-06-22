/**
 * One-command setup for job-hunter. Run after `npm install`:
 *
 *   npm run setup
 *
 * Does the post-install legwork so a non-engineer can get to a working `scan`:
 *   1. installs Chromium for Playwright,
 *   2. captures the REAL Airtable shared-view fixture (so tests/scan use live shape),
 *   3. seeds the skill dictionary into the local SQLite database,
 *   4. (interactive) collects the Anthropic API key, Airtable share URL, and a resume,
 *      persisting them so `scan` works immediately.
 *
 * Cross-platform (macOS Intel/ARM, Windows 11+). Non-interactive when stdin is not a TTY or
 * `--yes` is passed: it uses env vars (ANTHROPIC_API_KEY, AIRTABLE_SHARE_URL, RESUME) and defaults,
 * and never blocks. Network/browser steps degrade to warnings — setup never hard-fails the config.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import skillSeed from "../src/domain/data/skill-seed.json";
import { readResumeText } from "../src/profile/read-resume";
import { ensureDataDir, resolveDbPath } from "../src/runtime/paths";
import { DEFAULT_SHARE_URL, applyConfig, seedSkillDictionary } from "../src/runtime/setup-config";
import { Repository } from "../src/storage/repository";

const args = new Set(process.argv.slice(2));
const nonInteractive = args.has("--yes") || !stdin.isTTY;

/** Run a command with inherited stdio; `shell: true` resolves npm/npx `.cmd` on Windows. */
function run(command: string, label: string): boolean {
  console.log(`\n▶ ${label}`);
  const result = spawnSync(command, { stdio: "inherit", shell: true });
  if (result.status !== 0) {
    console.warn(`  ⚠ "${label}" did not complete cleanly — you can re-run it later.`);
    return false;
  }
  return true;
}

async function ask(question: string, fallback = ""): Promise<string> {
  if (nonInteractive) return fallback;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim() || fallback;
  } finally {
    rl.close();
  }
}

async function readResumeSafely(path: string): Promise<string | undefined> {
  if (!path) return undefined;
  if (!existsSync(path)) {
    console.warn(
      `  ⚠ resume not found at ${path} — skipping profile (run \`job-hunter profile\` later).`,
    );
    return undefined;
  }
  try {
    return await readResumeText(path);
  } catch (error) {
    console.warn(`  ⚠ could not read resume: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

async function main(): Promise<void> {
  console.log("job-hunter setup\n================");

  // 1. Playwright browser (needed for the Airtable read + careers-page rendering).
  run("npx playwright install chromium", "Installing Chromium for Playwright");

  // 2. Capture the real Airtable fixture so we're not running on the synthetic placeholder.
  run("npm run smoke:airtable", "Capturing the live Airtable shared-view fixture");

  // 2b. Build the web dashboard so `job-hunter serve` has static assets to serve.
  run("npm run build:web", "Building the web dashboard");

  // 3. Open the database and seed the skill dictionary.
  ensureDataDir();
  const repo = new Repository(resolveDbPath());
  try {
    const seeded = seedSkillDictionary(repo, skillSeed.skills);
    console.log(`\n✓ Seeded ${seeded} skills into ${resolveDbPath()}`);

    // 4. Guided config.
    console.log("\nLet's configure your search (press Enter to accept defaults / skip):");
    const apiKey = await ask(
      "  Anthropic API key (blank = free heuristic scoring): ",
      process.env.ANTHROPIC_API_KEY?.trim() ?? "",
    );
    const shareUrl = await ask(
      `  Airtable share URL [${DEFAULT_SHARE_URL}]: `,
      process.env.AIRTABLE_SHARE_URL?.trim() || DEFAULT_SHARE_URL,
    );
    const resumePath = await ask(
      "  Path to your resume (pdf/docx/md/txt, blank to skip): ",
      process.env.RESUME?.trim() ?? "",
    );
    const resumeText = await readResumeSafely(resumePath);

    const result = applyConfig(repo, { apiKey, shareUrl, resumeText });

    console.log("\n✓ Setup complete:");
    console.log(`  - API key: ${result.savedApiKey ? "saved" : "not set (heuristic scoring)"}`);
    console.log(`  - Airtable share: ${result.shareUrl}`);
    console.log(
      `  - Profile: ${result.profileSkills === null ? "not built yet" : `${result.profileSkills} skills`}`,
    );
    console.log("\nNext:");
    console.log("  npm run serve            # open the web dashboard");
    console.log("  — or use the CLI —");
    if (result.profileSkills === null) console.log("  npm run cli profile <your-resume-file>");
    console.log("  npm run cli scan");
    console.log("  npm run cli list --min-score 70");
  } finally {
    repo.close();
  }
}

main().catch((error) => {
  console.error("Setup failed:", error);
  process.exitCode = 1;
});

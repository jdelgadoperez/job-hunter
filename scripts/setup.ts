/**
 * One-command setup for job-hunter. Run after `npm install`:
 *
 *   npm run setup
 *
 * Does the post-install legwork so a non-engineer can get to a working `scan`:
 *   1. installs Chromium for Playwright and warms it up (first launch is done here, not mid-scan),
 *   2. builds the web dashboard,
 *   3. seeds the skill dictionary into the local SQLite database,
 *   4. (interactive) collects the Anthropic API key and a resume, persisting them so `scan` works
 *      immediately. (The company directory is a fixed community resource — no prompt.)
 *
 * Cross-platform (macOS Intel/ARM, Windows 11+). Non-interactive when stdin is not a TTY or
 * `--yes` is passed: it uses env vars (ANTHROPIC_API_KEY, RESUME) and defaults, and never blocks.
 * Network/browser steps degrade to warnings — setup never hard-fails the config.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import skillSeed from "../src/domain/data/skill-seed.json";
import { withTimeout } from "../src/net/with-timeout";
import { readResumeText } from "../src/profile/read-resume";
import { ensureDataDir, resolveDbPath } from "../src/runtime/paths";
import { applyConfig, seedSkillDictionary } from "../src/runtime/setup-config";
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

/**
 * Launch and close Chromium once so the first-run setup happens now, not during the first scan,
 * and so a missing browser or missing system libraries fails here with clear guidance. Bounded so
 * a stuck launch can't hang setup; never throws.
 */
async function warmUpBrowser(): Promise<void> {
  console.log("\n▶ Warming up the browser (first launch can take a moment)");
  try {
    const { chromium } = await import("playwright");
    const browser = await withTimeout(chromium.launch(), 60_000, "browser launch");
    await browser.close();
    console.log("  ✓ Chromium launches OK");
  } catch (error) {
    console.warn(`  ⚠ Chromium did not launch: ${error instanceof Error ? error.message : error}`);
    console.warn(
      "    Scans need a browser. Re-run: npx playwright install chromium chromium-headless-shell",
    );
    console.warn("    On Linux you may also need: npx playwright install-deps chromium");
  }
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

  // 1. Playwright browser (needed for the Airtable read + careers-page rendering). Install the
  // headless shell too: modern `chromium.launch()` runs headless via the separate
  // chrome-headless-shell binary, which a bare `install chromium` can leave out.
  run(
    "npx playwright install chromium chromium-headless-shell",
    "Installing Chromium for Playwright (browser + headless shell)",
  );

  // 1b. Warm up the browser now: the first launch does one-time setup, so doing it here moves that
  // cost out of the user's first scan — and surfaces a broken/missing browser with clear advice
  // instead of a scan that stalls on "Reading the company directory…".
  await warmUpBrowser();

  // 2. Build the web dashboard so `job-hunter serve` has static assets to serve.
  run("npm run build:web", "Building the web dashboard");

  // 3. Open the database and seed the skill dictionary.
  ensureDataDir();
  const repo = new Repository(resolveDbPath());
  try {
    const seeded = seedSkillDictionary(repo, skillSeed.skills);
    console.log(`\n✓ Seeded ${seeded} skills into ${resolveDbPath()}`);

    // 4. Guided config. (The company directory is a fixed community resource — no prompt needed.)
    console.log("\nLet's configure your search (press Enter to accept defaults / skip):");
    const apiKey = await ask(
      "  Anthropic API key (blank = free heuristic scoring): ",
      process.env.ANTHROPIC_API_KEY?.trim() ?? "",
    );
    const resumePath = await ask(
      "  Path to your resume (pdf/docx/md/txt, blank to skip): ",
      process.env.RESUME?.trim() ?? "",
    );
    const resumeText = await readResumeSafely(resumePath);

    const result = applyConfig(repo, { apiKey, resumeText });

    console.log("\n✓ Setup complete:");
    console.log(`  - API key: ${result.savedApiKey ? "saved" : "not set (heuristic scoring)"}`);
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

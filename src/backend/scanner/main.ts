import { PostgresScanStore } from "@app/backend/postgres-scan-store";
import { resolveShareUrl } from "@app/discovery/sources/airtable";
import { PlaywrightSharedViewReader } from "@app/discovery/sources/airtable-playwright";
import { formatProgress } from "@app/domain/scan-progress";
import type { SettingsReader } from "@app/matching/resolve-settings";
import { THE_MUSE_KEY_SETTING } from "@app/matching/settings-keys";
import { HttpFetcher } from "@app/net/fetcher";
import { PlaywrightRenderer } from "@app/net/playwright-renderer";
import postgres from "postgres";
import { runScannerOnce } from "./run-once";

/**
 * Production entrypoint for the hosted scanner worker (smoke-only, like the Playwright wrappers and
 * the Postgres store it uses). Runs ONE full sourcing pass against Postgres and exits, so a scheduler
 * (Fly.io/Railway cron or a GitHub Action) can invoke it on an interval. Crawls with a real browser +
 * live network, so it must run in a container with Chromium — never a serverless function.
 *
 * Env: DATABASE_URL (service-role Postgres connection, required); JOB_HUNTER_THE_MUSE_API_KEY
 * (optional, enables The Muse lead source). See docs/backend/worker-runbook.md.
 */

/** Lead-source settings come from env in the worker (no per-user DB); only key-gated sources read it. */
const envSettings: SettingsReader = {
  getSetting: (key) =>
    key === THE_MUSE_KEY_SETTING
      ? process.env.JOB_HUNTER_THE_MUSE_API_KEY?.trim() || undefined
      : undefined,
};

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[scanner] DATABASE_URL is required (service-role Postgres connection).");
    process.exitCode = 1;
    return;
  }

  const sql = postgres(url);
  const store = new PostgresScanStore(sql);
  try {
    const outcome = await runScannerOnce({
      store,
      discoverDeps: {
        fetcher: new HttpFetcher(),
        renderer: new PlaywrightRenderer(),
        sharedViewReader: new PlaywrightSharedViewReader(),
        shareUrl: resolveShareUrl(),
        settings: envSettings,
      },
      onProgress: (event) => console.log(`[scanner] ${formatProgress(event)}`),
    });
    console.log(
      `[scanner] done: wrote ${outcome.postings.length} posting(s); ` +
        `directory +${outcome.newCompanies.length}/-${outcome.removedCompanies.length}; ` +
        `expired ${outcome.expired}.`,
    );
    for (const warning of outcome.warnings) {
      console.warn(`[scanner] ! [${warning.source}] ${warning.message}`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error("[scanner] failed:", error);
  process.exitCode = 1;
});

import { withTimeout } from "@app/net/with-timeout";
import type { SharedViewReader } from "./airtable";

// Headless Chromium otherwise advertises a `HeadlessChrome` UA, which some sites (Airtable
// included) treat differently — serving a stripped page that never issues the data call. Present
// as an ordinary desktop Chrome so the embed behaves as it does in a real browser.
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = Number(process.env.JOB_HUNTER_DIRECTORY_TIMEOUT_MS) || 45_000;

/**
 * Production `SharedViewReader`: open the Airtable shared view in a real browser and capture the
 * `readSharedViewData` response the page issues itself — so Airtable's own page supplies the
 * access policy and we never reverse-engineer it. Integration-bound (browser + network); no unit
 * tests, exercised only by `npm run smoke:airtable`. Requires `npx playwright install chromium`.
 */
export class PlaywrightSharedViewReader implements SharedViewReader {
  constructor(private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

  async read(shareUrl: string): Promise<unknown> {
    const { chromium } = await import("playwright");
    // Cap browser startup too (a slow/missing/downloading Chromium otherwise hangs unbounded).
    const browser = await chromium.launch({ timeout: this.timeoutMs });
    try {
      // Hard wall-clock cap on the whole capture, a little above the per-step timeout so a
      // descriptive `capture` rejection wins the race against the bare wall-clock timeout.
      const capture = this.capture(browser, shareUrl);
      // Swallow a late rejection if the deadline wins, so it isn't an unhandled rejection.
      capture.catch(() => {});
      return await withTimeout(capture, this.timeoutMs + 10_000, "Airtable shared-view read");
    } finally {
      await browser.close();
    }
  }

  private async capture(
    browser: Awaited<ReturnType<typeof import("playwright").chromium.launch>>,
    shareUrl: string,
  ): Promise<unknown> {
    const context = await browser.newContext({
      userAgent: DESKTOP_UA,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    // Record every readSharedViewData response (even non-200s) so a failure can explain itself.
    const seen: string[] = [];
    page.on("response", (response) => {
      if (response.url().includes("readSharedViewData")) {
        seen.push(`${response.status()} ${response.url()}`);
      }
    });

    try {
      // Arm the response wait before navigating so we don't miss the call.
      const dataResponse = page.waitForResponse(
        (response) => response.url().includes("readSharedViewData") && response.ok(),
        { timeout: this.timeoutMs },
      );
      await page.goto(shareUrl, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
      const response = await dataResponse;
      return await response.json();
    } catch (error) {
      const detail =
        seen.length > 0
          ? `the data call returned a non-OK status (seen: ${seen.join("; ")})`
          : `the page never issued a readSharedViewData request (final URL: ${page.url()}) — Airtable may be serving a blocked/headless page, or the share URL has changed`;
      throw new Error(`Airtable directory capture failed: ${detail}`, { cause: error });
    }
  }
}

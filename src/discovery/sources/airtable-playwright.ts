import { withTimeout } from "@app/net/with-timeout";
import type { SharedViewReader } from "./airtable";

/**
 * Production `SharedViewReader`: open the Airtable shared view in a real browser and capture the
 * `readSharedViewData` response the page issues itself — so Airtable's own page supplies the
 * access policy and we never reverse-engineer it. Integration-bound (browser + network); no unit
 * tests, exercised only by `npm run smoke:airtable`. Requires `npx playwright install chromium`.
 */
export class PlaywrightSharedViewReader implements SharedViewReader {
  constructor(private readonly timeoutMs = 30_000) {}

  async read(shareUrl: string): Promise<unknown> {
    const { chromium } = await import("playwright");
    // Cap browser startup too (a slow/missing/downloading Chromium otherwise hangs unbounded).
    const browser = await chromium.launch({ timeout: this.timeoutMs });
    try {
      // Hard wall-clock cap on the whole capture: Playwright's per-step timeouts don't bound the
      // total, so without this the scan can sit on "Reading the company directory…" indefinitely.
      const capture = this.capture(browser, shareUrl);
      // Swallow a late rejection if the deadline wins, so it isn't an unhandled rejection.
      capture.catch(() => {});
      return await withTimeout(capture, this.timeoutMs, "Airtable shared-view read");
    } finally {
      await browser.close();
    }
  }

  private async capture(
    browser: Awaited<ReturnType<typeof import("playwright").chromium.launch>>,
    shareUrl: string,
  ): Promise<unknown> {
    const page = await browser.newPage();
    // Arm the response wait before navigating so we don't miss the call.
    const dataResponse = page.waitForResponse(
      (response) => response.url().includes("readSharedViewData") && response.ok(),
      { timeout: this.timeoutMs },
    );
    await page.goto(shareUrl, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
    const response = await dataResponse;
    return await response.json();
  }
}

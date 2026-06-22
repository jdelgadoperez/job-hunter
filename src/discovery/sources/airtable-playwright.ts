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
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      // Arm the response wait before navigating so we don't miss the call.
      const dataResponse = page.waitForResponse(
        (response) => response.url().includes("readSharedViewData") && response.ok(),
        { timeout: this.timeoutMs },
      );
      await page.goto(shareUrl, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
      const response = await dataResponse;
      return await response.json();
    } finally {
      await browser.close();
    }
  }
}

import type { PageRenderer } from "@app/discovery/connectors/browser";

/**
 * Production `PageRenderer` backed by Playwright/Chromium. This is an integration-bound edge
 * (a real browser + live network), so it has no unit tests — it's exercised only by the opt-in
 * smoke scripts, exactly like `HttpFetcher`. Requires `npx playwright install chromium`.
 */
export class PlaywrightRenderer implements PageRenderer {
  constructor(private readonly timeoutMs = 30_000) {}

  async render(url: string): Promise<string> {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "networkidle", timeout: this.timeoutMs });
      return await page.content();
    } finally {
      await browser.close();
    }
  }
}

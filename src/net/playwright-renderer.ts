import type { PageRenderer } from "@app/discovery/connectors/browser";
import { assertAllowedUrl } from "@app/net/ssrf-guard";
import { withTimeout } from "@app/net/with-timeout";

/**
 * Production `PageRenderer` backed by Playwright/Chromium. This is an integration-bound edge
 * (a real browser + live network), so it has no unit tests — it's exercised only by the opt-in
 * smoke scripts, exactly like `HttpFetcher`. Requires `npx playwright install chromium chromium-headless-shell`.
 */
export class PlaywrightRenderer implements PageRenderer {
  constructor(private readonly timeoutMs = 30_000) {}

  async render(url: string): Promise<string> {
    // Refuse internal targets before spinning up a browser. (Redirects encountered mid-render are a
    // residual gap — Playwright follows them internally — but a directly internal URL is blocked.)
    await assertAllowedUrl(url);
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ timeout: this.timeoutMs });
    try {
      const work = this.load(browser, url);
      work.catch(() => {});
      return await withTimeout(work, this.timeoutMs, `Render ${url}`);
    } finally {
      await browser.close();
    }
  }

  private async load(
    browser: Awaited<ReturnType<typeof import("playwright").chromium.launch>>,
    url: string,
  ): Promise<string> {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: this.timeoutMs });
    return await page.content();
  }
}

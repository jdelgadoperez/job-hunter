import type { PageRenderer } from "@app/discovery/connectors/browser";
import { assertAllowedUrl } from "@app/net/ssrf-guard";
import { withTimeout } from "@app/net/with-timeout";

type Browser = Awaited<ReturnType<typeof import("playwright").chromium.launch>>;

/**
 * Production `PageRenderer` backed by Playwright/Chromium. This is an integration-bound edge
 * (a real browser + live network), so it has no unit tests — it's exercised only by the opt-in
 * smoke scripts, exactly like `HttpFetcher`. Requires `npx playwright install chromium chromium-headless-shell`.
 *
 * One Chromium process is launched lazily on the first render and reused for every subsequent
 * render in the scan (a fresh `page` per call keeps requests isolated). `dispose()` closes it once
 * at the end of discovery, amortizing the ~300ms–1s launch cost across the whole run instead of
 * paying it per company.
 */
export class PlaywrightRenderer implements PageRenderer {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;

  constructor(private readonly timeoutMs = 30_000) {}

  async render(url: string): Promise<string> {
    // Refuse internal targets before spinning up a browser. (Redirects encountered mid-render are a
    // residual gap — Playwright follows them internally — but a directly internal URL is blocked.)
    await assertAllowedUrl(url);
    const browser = await this.getBrowser();
    const work = this.load(browser, url);
    work.catch(() => {});
    return await withTimeout(work, this.timeoutMs, `Render ${url}`);
  }

  /** Close the shared browser. Safe to call when none was ever launched. Called once after a scan. */
  async dispose(): Promise<void> {
    const browser = this.browser ?? (this.launching ? await this.launching : null);
    this.browser = null;
    this.launching = null;
    if (browser) await browser.close();
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    // Coalesce concurrent first-render calls onto a single launch.
    if (!this.launching) {
      this.launching = import("playwright").then(({ chromium }) =>
        chromium.launch({ timeout: this.timeoutMs }),
      );
    }
    this.browser = await this.launching;
    return this.browser;
  }

  private async load(browser: Browser, url: string): Promise<string> {
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: this.timeoutMs });
      return await page.content();
    } finally {
      await page.close();
    }
  }
}

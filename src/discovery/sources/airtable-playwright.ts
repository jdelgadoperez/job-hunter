import { withTimeout } from "@app/net/with-timeout";
import type { SharedViewReader } from "./airtable";

// Headless Chromium otherwise advertises a `HeadlessChrome` UA, which some sites (Airtable
// included) treat differently — serving a stripped page that never issues the data call. Present
// as an ordinary desktop Chrome so the embed behaves as it does in a real browser.
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = Number(process.env.JOB_HUNTER_DIRECTORY_TIMEOUT_MS) || 45_000;

/** Response URLs worth reporting on failure — the data call, plus other Airtable API traffic. */
function isApiResponse(url: string): boolean {
  return /readSharedViewData|readSharedView|sharedView|airtable\.com\/v\d/i.test(url);
}

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
      // Backstop only: the capture's own wait has a hard timeout, but guard the total in case the
      // browser itself wedges. The descriptive `capture` rejection settles first and wins the race.
      const capture = this.capture(browser, shareUrl);
      capture.catch(() => {}); // avoid an unhandled rejection if the backstop ever wins
      return await withTimeout(capture, this.timeoutMs + 15_000, "Airtable shared-view read");
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
      locale: "en-US",
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });
    // Mask the most obvious headless tell so bot-detection serves the normal data-loading page.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = await context.newPage();

    // Record Airtable API responses (even non-200s) so a failure can explain itself.
    const seen: string[] = [];
    page.on("response", (response) => {
      const url = response.url();
      if (isApiResponse(url)) seen.push(`${response.status()} ${url.slice(0, 140)}`);
    });

    // Arm the data wait BEFORE navigating, and DON'T await the navigation itself: in headless,
    // `goto` can hang past its own timeout on a challenge/redirect, which would starve this wait
    // and surface only a bare wall-clock timeout. Awaiting the response (hard-timeout-bounded)
    // guarantees we either get the data or throw a descriptive error.
    const dataResponse = page.waitForResponse(
      (response) => response.url().includes("readSharedViewData") && response.ok(),
      { timeout: this.timeoutMs },
    );
    page.goto(shareUrl, { waitUntil: "domcontentloaded", timeout: this.timeoutMs }).catch(() => {});

    try {
      const response = await dataResponse;
      return await response.json();
    } catch (error) {
      const detail =
        seen.length > 0
          ? `the data call did not return OK within ${this.timeoutMs}ms (Airtable responses seen: ${seen.join(" | ")})`
          : `no readSharedViewData request was made within ${this.timeoutMs}ms (final URL: ${page.url()}) — Airtable is likely serving a blocked/headless page, or the request was renamed`;
      throw new Error(`Airtable directory capture failed: ${detail}`, { cause: error });
    }
  }
}

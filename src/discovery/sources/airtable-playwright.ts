import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTimeout } from "@app/net/with-timeout";
import type { SharedViewReader } from "./airtable";

// Headless Chromium otherwise advertises a `HeadlessChrome` UA, which some sites (Airtable
// included) treat differently — serving a stripped page that never issues the data call. Present
// as an ordinary desktop Chrome so the embed behaves as it does in a real browser.
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = Number(process.env.JOB_HUNTER_DIRECTORY_TIMEOUT_MS) || 45_000;

/** Step trace to stderr so a stall is locatable; stdout stays reserved for the captured data. */
function step(message: string): void {
  console.error(`[airtable] ${message}`);
}

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
    step("launching Chromium…");
    const browser = await chromium.launch({ timeout: this.timeoutMs });
    step("Chromium launched");
    try {
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
    step("creating browser context");
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
    step("opening page");
    const page = await context.newPage();

    // Record (and trace) Airtable API responses so a failure can explain itself.
    const seen: string[] = [];
    page.on("response", (response) => {
      const url = response.url();
      if (isApiResponse(url)) {
        seen.push(`${response.status()} ${url.slice(0, 140)}`);
        step(`api response ${response.status()} ${url.slice(0, 100)}`);
      }
    });

    // Arm the data wait BEFORE navigating, and DON'T await the navigation: in headless, `goto`
    // can hang past its own timeout on a challenge/redirect, which would starve this wait.
    const dataResponse = page.waitForResponse(
      (response) => response.url().includes("readSharedViewData") && response.ok(),
      { timeout: this.timeoutMs },
    );
    step(`navigating to ${shareUrl}`);
    page
      .goto(shareUrl, { waitUntil: "domcontentloaded", timeout: this.timeoutMs })
      .then(() => step("navigation committed"))
      .catch((error) =>
        step(`navigation error: ${error instanceof Error ? error.message : error}`),
      );

    try {
      step("waiting for readSharedViewData…");
      const response = await dataResponse;
      step("got data response; parsing JSON");
      return await response.json();
    } catch (error) {
      // Best-effort: capture what headless actually rendered, to tell a bot wall from a renamed
      // data call. Wrapped because the page may be in a bad state.
      try {
        const png = join(process.cwd(), "airtable-debug.png");
        const html = join(process.cwd(), "airtable-debug.html");
        await page.screenshot({ path: png });
        writeFileSync(html, await page.content());
        step(`wrote debug artifacts: ${png} and ${html} — please share the screenshot`);
      } catch (dumpError) {
        step(
          `could not write debug artifacts: ${dumpError instanceof Error ? dumpError.message : dumpError}`,
        );
      }
      const detail =
        seen.length > 0
          ? `the data call did not return OK within ${this.timeoutMs}ms (Airtable responses seen: ${seen.join(" | ")})`
          : `no readSharedViewData request was made within ${this.timeoutMs}ms (final URL: ${page.url()}) — Airtable is likely serving a blocked/headless page, or the request was renamed`;
      throw new Error(`Airtable directory capture failed: ${detail}`, { cause: error });
    }
  }
}

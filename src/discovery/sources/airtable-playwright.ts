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

    // Airtable returns readSharedViewData (200) and then immediately redirects the tab to a sign-in
    // wall, which tears the page down. If we await the Response and read its body a beat later,
    // `response.json()` hangs because the page is gone. So read the body *in the response handler*,
    // the instant it arrives — and resolve on the first one we successfully parse (Airtable may
    // emit the call more than once).
    const seen: string[] = [];
    let resolveData: (value: unknown) => void = () => {};
    const dataBody = new Promise<unknown>((resolve) => {
      resolveData = resolve;
    });
    page.on("response", (response) => {
      const url = response.url();
      if (!isApiResponse(url)) return;
      seen.push(`${response.status()} ${url.slice(0, 140)}`);
      step(`api response ${response.status()} ${url.slice(0, 100)}`);
      if (url.includes("readSharedViewData") && response.ok()) {
        response.json().then(
          (json) => {
            step("captured shared-view data body");
            resolveData(json);
          },
          (error) =>
            step(`could not read data body: ${error instanceof Error ? error.message : error}`),
        );
      }
    });

    // Don't await the navigation: in headless it redirects to /login, and `goto` can hang past its
    // own timeout. We only need the captured data body.
    step(`navigating to ${shareUrl}`);
    page
      .goto(shareUrl, { waitUntil: "commit", timeout: this.timeoutMs })
      .then(() => step("navigation committed"))
      .catch((error) =>
        step(`navigation error: ${error instanceof Error ? error.message : error}`),
      );

    try {
      step("waiting for shared-view data…");
      return await withTimeout(dataBody, this.timeoutMs, "readSharedViewData capture");
    } catch (error) {
      // Best-effort: capture what headless rendered (likely the sign-in wall) for diagnosis.
      try {
        const png = join(process.cwd(), "airtable-debug.png");
        const html = join(process.cwd(), "airtable-debug.html");
        await page.screenshot({ path: png });
        writeFileSync(html, await page.content());
        step(`wrote debug artifacts: ${png} and ${html}`);
      } catch (dumpError) {
        step(
          `could not write debug artifacts: ${dumpError instanceof Error ? dumpError.message : dumpError}`,
        );
      }
      const detail =
        seen.length > 0
          ? `the data body never parsed within ${this.timeoutMs}ms (Airtable responses seen: ${seen.join(" | ")})`
          : `no readSharedViewData request was made within ${this.timeoutMs}ms (final URL: ${page.url()}) — Airtable is likely serving a blocked/headless page, or the request was renamed`;
      throw new Error(`Airtable directory capture failed: ${detail}`, { cause: error });
    }
  }
}

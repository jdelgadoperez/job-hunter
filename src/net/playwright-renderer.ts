import type { PageRenderer } from "@app/discovery/connectors/browser";
import { assertAllowedUrl, BlockedUrlError } from "@app/net/ssrf-guard";
import { withTimeout } from "@app/net/with-timeout";

type Browser = Awaited<ReturnType<typeof import("playwright").chromium.launch>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;
type Route = Parameters<Parameters<Page["route"]>[1]>[0];

/** Redirect hops we'll follow per navigation before refusing — matches HttpFetcher's cap. */
const MAX_REDIRECTS = 5;

/**
 * Decide how to handle an intercepted browser request. Main-frame navigations (the initial load,
 * HTTP redirects, and client-side document navigation) are re-validated against the SSRF guard, so a
 * public careers page can't redirect or navigate the browser onto an internal address (127.0.0.1,
 * 169.254.169.254 metadata, LAN). Sub-resource requests (scripts, images, XHR) are let through
 * unchecked — they can't turn the returned page.content() into internal-resource HTML the way a
 * navigation can, and validating each would add a DNS lookup per asset.
 *
 * Extracted as a pure function so the decision is unit-testable without launching a real browser.
 */
export async function screenNavigation(
  url: string,
  isNavigation: boolean,
  assertAllowed: (u: string) => Promise<unknown> = assertAllowedUrl,
): Promise<"continue" | "abort"> {
  if (!isNavigation) return "continue";
  try {
    await assertAllowed(url);
    return "continue";
  } catch (error) {
    if (error instanceof BlockedUrlError) return "abort";
    throw error;
  }
}

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
    // Refuse internal targets before spinning up a browser. Redirects and client-side navigation
    // encountered mid-render are re-checked by the route handler in load(), so a public page can't
    // bounce us onto an internal address after this initial check.
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
      // Re-check every navigation the browser attempts against the SSRF guard. Chromium follows HTTP
      // redirects internally and does NOT re-fire this handler for the redirect target (neither
      // `route.continue()` nor `route.fulfill()` of a 3xx re-enters interception), so we must follow
      // the whole chain ourselves: fetch each hop with `maxRedirects: 0`, validate the `Location`
      // before following it, and only fulfill the terminal (non-redirect) response. Client-side
      // navigation (JS `location=`, meta refresh) re-enters as a fresh navigation request and is
      // validated the same way. This closes the gap where render()'s initial guard only saw the
      // first URL and a public careers page could bounce us onto an internal address (127.0.0.1,
      // 169.254.169.254 metadata, LAN).
      await page.route("**/*", (route: Route) => this.routeNavigation(route));
      await page.goto(url, { waitUntil: "networkidle", timeout: this.timeoutMs });
      return await page.content();
    } finally {
      // A route handler still awaiting route.fetch() for another in-flight request when the page
      // closes throws TargetClosedError on its own detached promise — outside this try/catch and
      // outside withTimeout's race — which Node surfaces as an unhandled rejection and crashes the
      // whole scan process. unrouteAll's 'ignoreErrors' discards exactly those in-flight failures.
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.close();
    }
  }

  /** Intercept one browser request. Sub-resources pass through; navigations follow their redirect
   *  chain under the SSRF guard, aborting if any hop targets an internal address. */
  private async routeNavigation(route: Route): Promise<void> {
    const request = route.request();
    if (!request.isNavigationRequest()) {
      await route.continue();
      return;
    }
    let current = request.url();
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if ((await screenNavigation(current, true)) === "abort") {
        await route.abort("blockedbyclient");
        return;
      }
      const response = await route.fetch({ url: current, maxRedirects: 0 });
      const status = response.status();
      const location = response.headers().location;
      if (status >= 300 && status < 400 && location) {
        current = new URL(location, current).href;
        continue;
      }
      await route.fulfill({ response });
      return;
    }
    // Exhausted the redirect budget without reaching a terminal response — refuse rather than loop.
    await route.abort("blockedbyclient");
  }
}

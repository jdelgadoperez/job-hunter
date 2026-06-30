import type { JobPosting } from "@app/domain/types";
import { extractJsonLdPostings } from "./jsonld";

/**
 * Renders a URL to its final HTML. The production implementation drives a headless
 * browser (Playwright); the automated suite injects a fake that returns a fixture.
 * This is the only genuinely integration-bound seam, so its live behavior is
 * exercised only by the opt-in smoke script.
 */
export interface PageRenderer {
  render(url: string): Promise<string>;
  /**
   * Release any resources held across renders (e.g. a shared headless browser). Optional: the
   * fake renderer used in tests holds nothing. Called once by `discover` after the run completes.
   */
  dispose?(): Promise<void>;
}

/**
 * Generic fallback for companies with no recognized ATS: render the careers page,
 * then run the pure JSON-LD extractor over the rendered HTML.
 */
export class BrowserConnector {
  readonly source = "browser";

  async fetchPostings(
    careersUrl: string,
    company: string,
    renderer: PageRenderer,
  ): Promise<JobPosting[]> {
    const html = await renderer.render(careersUrl);
    return extractJsonLdPostings(html, careersUrl, company);
  }
}

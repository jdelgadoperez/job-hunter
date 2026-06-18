/**
 * Opt-in, manual smoke test for the network-bound connectors. NOT part of `npm test`.
 *
 *   npm run smoke
 *
 * Hits real ATS boards and a JSON-LD careers page with the production `HttpFetcher`
 * and a Playwright-backed renderer, printing the normalized postings and any
 * warnings. It is polite by default (the orchestrator's concurrency cap + delay) and
 * verifies the connectors still match real-world feeds when run intentionally.
 *
 * The browser path needs a Chromium build: `npx playwright install chromium`.
 * Board tokens below are public but may go stale; update them if a feed 404s.
 */
import { AshbyConnector } from "../src/discovery/connectors/ashby";
import type { PageRenderer } from "../src/discovery/connectors/browser";
import { GreenhouseConnector } from "../src/discovery/connectors/greenhouse";
import { extractJsonLdPostings } from "../src/discovery/connectors/jsonld";
import { LeverConnector } from "../src/discovery/connectors/lever";
import { HttpFetcher } from "../src/net/fetcher";

class PlaywrightRenderer implements PageRenderer {
  async render(url: string): Promise<string> {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "networkidle" });
      return await page.content();
    } finally {
      await browser.close();
    }
  }
}

async function main(): Promise<void> {
  const fetcher = new HttpFetcher();

  const boards = [
    { connector: new GreenhouseConnector(), token: "gitlab" },
    { connector: new LeverConnector(), token: "leverdemo" },
    { connector: new AshbyConnector(), token: "ashby" },
  ];

  for (const { connector, token } of boards) {
    try {
      const result = await connector.fetchPostings(token, fetcher);
      if (!result.ok) {
        console.error(`[${connector.source}:${token}] ${result.warning}`);
        continue;
      }
      console.log(`\n[${connector.source}:${token}] ${result.postings.length} postings`);
      for (const posting of result.postings.slice(0, 3)) {
        console.log(`  - ${posting.title} (${posting.url})`);
      }
    } catch (error) {
      console.error(`[${connector.source}:${token}] failed:`, error);
    }
  }

  const careersUrl = "https://www.anthropic.com/jobs";
  try {
    const html = await new PlaywrightRenderer().render(careersUrl);
    const postings = extractJsonLdPostings(html, careersUrl, "browser-smoke");
    console.log(`\n[browser:${careersUrl}] ${postings.length} json-ld postings`);
    for (const posting of postings.slice(0, 3)) {
      console.log(`  - ${posting.title} (${posting.url})`);
    }
  } catch (error) {
    console.error(`[browser:${careersUrl}] failed:`, error);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

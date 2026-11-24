import { resolveAts } from "./resolve-ats";
import { isUnscrapableHost } from "./unscrapable";

/**
 * How a scan reads a company's careers page: the ATS connector's `source` (e.g. `"greenhouse"`) when
 * the URL is a known board, `"manual"` for hosts we deliberately don't scrape (LinkedIn/Indeed/…),
 * and `"browser"` for everything else (the page is rendered and parsed). Mirrors the order
 * `discover()` applies, so the All companies view says what a scan will actually do.
 */
export function scanMethod(careersUrl: string): string {
  if (isUnscrapableHost(careersUrl)) return "manual";
  return resolveAts(careersUrl)?.connector.source ?? "browser";
}

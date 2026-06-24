/**
 * Hosts the tool deliberately does not scrape: their careers pages require login and sit behind
 * bot/anti-scraping walls, and their terms prohibit automated access (see the README/usage privacy
 * note). A scan skips rendering these — otherwise each one is a ~30s headless timeout that returns
 * nothing — and surfaces them for manual review instead.
 */
const UNSCRAPABLE_HOSTS = ["linkedin.com", "indeed.com", "glassdoor.com"];

/** True if `url`'s host is one we deliberately don't scrape (matches the host and its subdomains). */
export function isUnscrapableHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return UNSCRAPABLE_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

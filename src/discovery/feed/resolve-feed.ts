import type { SettingsReader } from "@app/matching/resolve-settings";
import { FEED_KEY_SETTING, FEED_URL_SETTING } from "@app/matching/settings-keys";
import type { Fetcher } from "@app/net/fetcher";
import { HttpPostingFeed, type PostingFeed } from "./posting-feed";

/**
 * Build the remote `PostingFeed` from settings, or `undefined` when no `feedUrl` is configured — in
 * which case the scan runs a full local crawl. Shared by the CLI and the web server so both enter
 * hybrid remote mode identically. `feedKey` is the Supabase anon key (read-only by RLS).
 */
export function resolvePostingFeed(
  settings: SettingsReader,
  fetcher: Fetcher,
): PostingFeed | undefined {
  const baseUrl = settings.getSetting(FEED_URL_SETTING)?.trim();
  if (!baseUrl) return undefined;
  const apiKey = settings.getSetting(FEED_KEY_SETTING)?.trim() ?? "";
  return new HttpPostingFeed({ fetcher, baseUrl, apiKey });
}

import type { SettingsReader } from "@app/matching/resolve-settings";
import { FEED_KEY_SETTING, FEED_URL_SETTING } from "@app/matching/settings-keys";
import type { Fetcher } from "@app/net/fetcher";
import { describe, expect, it } from "vitest";
import { HttpPostingFeed } from "./posting-feed";
import { resolvePostingFeed } from "./resolve-feed";

const fetcher: Fetcher = { fetch: async () => ({ statusCode: 200, finalUrl: "", bodyText: "[]" }) };

function settings(values: Record<string, string>): SettingsReader {
  return { getSetting: (key) => values[key] };
}

describe("resolvePostingFeed", () => {
  it("returns undefined when no feed URL is configured (→ local crawl)", () => {
    expect(resolvePostingFeed(settings({}), fetcher)).toBeUndefined();
    expect(resolvePostingFeed(settings({ [FEED_URL_SETTING]: "   " }), fetcher)).toBeUndefined();
  });

  it("builds an HttpPostingFeed when a feed URL is set", () => {
    const feed = resolvePostingFeed(
      settings({ [FEED_URL_SETTING]: "https://proj.supabase.co", [FEED_KEY_SETTING]: "anon" }),
      fetcher,
    );
    expect(feed).toBeInstanceOf(HttpPostingFeed);
  });
});

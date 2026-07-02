/** Canonical `settings` table keys, centralized so the CLI, server, and matching layers agree. */
export const ANTHROPIC_KEY_SETTING = "anthropicApiKey";
export const MODEL_SETTING = "scorerModel";
export const PROVIDER_SETTING = "scorerProvider";
export const REMOTE_ONLY_SETTING = "remoteOnly";
export const THE_MUSE_KEY_SETTING = "theMuseApiKey";
// Remote shared feed (hosted scan backend). When `feedUrl` is set, a scan runs in hybrid remote
// mode: pull the cloud feed + crawl only tracked companies. `feedKey` is the Supabase anon key.
export const FEED_URL_SETTING = "feedUrl";
export const FEED_KEY_SETTING = "feedKey";
export const HOME_COUNTRY_SETTING = "homeCountry";

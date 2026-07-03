import {
  DEFAULT_PROVIDER,
  LLM_PROVIDERS,
  type LlmProviderConfig,
  type LlmProviderId,
} from "./llm-providers";
import { parseCountry } from "./location-filter";
import {
  ANTHROPIC_KEY_SETTING,
  HOME_COUNTRY_SETTING,
  MODEL_SETTING,
  PROVIDER_SETTING,
  SCAN_FRESHNESS_SETTING,
} from "./settings-keys";

// Re-exported so existing importers (and tests) can keep reaching these via resolve-settings.
export { MODEL_SETTING, PROVIDER_SETTING } from "./settings-keys";

/** Minimal structural reader, satisfied by `Repository`. */
export interface SettingsReader {
  getSetting(key: string): string | undefined;
}

/**
 * Wrap a `SettingsReader` so a missing Anthropic API key falls back to the `ANTHROPIC_API_KEY`
 * env var. Stored settings always win; the env var is only consulted when the key is unset.
 * Shared by the CLI and the web server so both resolve the key identically.
 */
export function settingsWithEnvKey(base: SettingsReader): SettingsReader {
  return {
    getSetting: (key) => {
      const stored = base.getSetting(key);
      if (stored !== undefined) return stored;
      if (key === ANTHROPIC_KEY_SETTING) return process.env.ANTHROPIC_API_KEY?.trim() || undefined;
      return undefined;
    },
  };
}

/**
 * Resolve the active provider config from settings, falling back to the default provider
 * when the setting is unset, blank, or an unrecognized id.
 */
function isLlmProviderId(id: string): id is LlmProviderId {
  return Object.hasOwn(LLM_PROVIDERS, id);
}

export function resolveProvider(settings: SettingsReader): LlmProviderConfig {
  const id = settings.getSetting(PROVIDER_SETTING)?.trim();
  if (id && isLlmProviderId(id)) {
    return LLM_PROVIDERS[id];
  }
  return LLM_PROVIDERS[DEFAULT_PROVIDER];
}

/** The trimmed API key for the given provider, or `undefined` when unset/blank. */
export function resolveApiKey(
  settings: SettingsReader,
  provider: LlmProviderConfig,
): string | undefined {
  const key = settings.getSetting(provider.apiKeySetting)?.trim();
  return key ? key : undefined;
}

/** The configured scorer model, or the provider's default when unset. */
export function resolveScorerModel(settings: SettingsReader, provider: LlmProviderConfig): string {
  const model = settings.getSetting(MODEL_SETTING)?.trim();
  return model ? model : provider.defaultModel;
}

/**
 * The user's home country label, or undefined when unset/blank (feature off). Canonicalizes a
 * free-text entry ("United States" / "USA" / "us") to the same label postings resolve to ("US") so
 * the country comparison in `isOffCountryNonStarter` matches — otherwise a user's own domestic
 * on-site roles would be wrongly excluded. Falls back to the trimmed raw value when `parseCountry`
 * can't resolve it: an unrecognized entry simply won't match any posting's country rather than
 * being dropped.
 */
export function resolveHomeCountry(settings: SettingsReader): string | undefined {
  const value = settings.getSetting(HOME_COUNTRY_SETTING)?.trim();
  if (!value) return undefined;
  return parseCountry(value) ?? value;
}

/** Default incremental-scan freshness window: skip companies scanned within the last 24h. */
export const SCAN_FRESHNESS_HOURS_DEFAULT = 24;

/**
 * Resolve the incremental-scan freshness window (hours) from settings. A stored non-negative number
 * wins (including `0`, which disables skipping); anything unset, non-numeric, or negative falls back
 * to the default.
 */
export function resolveScanFreshnessHours(settings: SettingsReader): number {
  const raw = settings.getSetting(SCAN_FRESHNESS_SETTING)?.trim();
  if (raw === undefined || raw === "") return SCAN_FRESHNESS_HOURS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : SCAN_FRESHNESS_HOURS_DEFAULT;
}

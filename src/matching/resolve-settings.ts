import {
  DEFAULT_PROVIDER,
  LLM_PROVIDERS,
  type LlmProviderConfig,
  type LlmProviderId,
} from "./llm-providers";

/** Minimal structural reader, satisfied by `Repository`. */
export interface SettingsReader {
  getSetting(key: string): string | undefined;
}

export const PROVIDER_SETTING = "scorerProvider";
export const MODEL_SETTING = "scorerModel";
const ANTHROPIC_KEY_SETTING = "anthropicApiKey";

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
export function resolveProvider(settings: SettingsReader): LlmProviderConfig {
  const id = settings.getSetting(PROVIDER_SETTING)?.trim();
  if (id && id in LLM_PROVIDERS) {
    return LLM_PROVIDERS[id as LlmProviderId];
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

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

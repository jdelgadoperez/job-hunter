import { AnthropicLlmClient, type LlmClient } from "./llm-client";
import { ANTHROPIC_KEY_SETTING } from "./settings-keys";

/** String-literal union of supported engines. Grows as a sibling client is added. */
export type LlmProviderId = "anthropic";

export interface LlmProviderConfig {
  id: LlmProviderId;
  /** `settings` key holding this provider's API key. */
  apiKeySetting: string;
  /** Model used when the `scorerModel` setting is unset. */
  defaultModel: string;
  createClient(opts: { apiKey: string; model: string }): LlmClient;
}

/**
 * The provider registry — the only place that names a concrete engine. Adding OpenAI/Gemini
 * later means appending an entry here plus a sibling `LlmClient` class, with no change to
 * `LlmScorer`, the prompt builder, the mapping, or the resolvers.
 */
export const LLM_PROVIDERS: Record<LlmProviderId, LlmProviderConfig> = {
  anthropic: {
    id: "anthropic",
    apiKeySetting: ANTHROPIC_KEY_SETTING,
    defaultModel: "claude-sonnet-4-6",
    createClient: (opts) => new AnthropicLlmClient(opts),
  },
};

export const DEFAULT_PROVIDER: LlmProviderId = "anthropic";

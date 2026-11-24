import { AnthropicLlmClient, type LlmClient } from "./llm-client";
import type { LlmUsage } from "./llm-usage";
import { ANTHROPIC_KEY_SETTING } from "./settings-keys";

/** String-literal union of supported engines. Grows as a sibling client is added. */
export type LlmProviderId = "anthropic";

/** A model offered in the dashboard's scorer-model picker. Any other model ID can still be typed. */
export interface ScorerModelOption {
  id: string;
  label: string;
  /** One line on when to pick it, shown under the picker. */
  note: string;
}

export interface LlmProviderConfig {
  id: LlmProviderId;
  /** `settings` key holding this provider's API key. */
  apiKeySetting: string;
  /** Model used when the `scorerModel` setting is unset. */
  defaultModel: string;
  /** Models offered in the Settings picker, default first. Not a whitelist: the setting accepts
   *  any model ID the provider serves. */
  models: ScorerModelOption[];
  /** Rough per-call USD rates used only for the `score --dry-run` cost preview (not billing). */
  cost: { perTriageTitleUsd: number; perDeepScoreUsd: number };
  createClient(opts: {
    apiKey: string;
    model: string;
    onUsage?: (usage: LlmUsage) => void;
  }): LlmClient;
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
    defaultModel: "claude-sonnet-5-5",
    // List prices per million input / output tokens, for choosing; the dry-run estimate below is
    // still the Sonnet-rate figure.
    models: [
      {
        id: "claude-sonnet-5-5",
        label: "Claude Sonnet 5.5",
        note: "Balanced quality and cost. $2 / $10 per million input / output tokens.",
      },
      {
        id: "claude-haiku-5-5",
        label: "Claude Haiku 5.5",
        note: "Fastest and cheapest, for large backlogs. $0.10 / $0.50 per million tokens.",
      },
      {
        id: "claude-opus-5-5",
        label: "Claude Opus 5.5",
        note: "Most thorough judgment, at about twice Sonnet's price. $4 / $20 per million tokens.",
      },
      {
        id: "claude-sonnet-5",
        label: "Claude Sonnet 5",
        note: "The previous default. $2 / $10 per million tokens.",
      },
    ],
    // Approximate Sonnet rates for the dry-run preview; titles are tiny, deep scores carry the
    // full description. Tune as real usage data arrives — this is a labeled estimate, not billing.
    cost: { perTriageTitleUsd: 0.002, perDeepScoreUsd: 0.03 },
    createClient: (opts) => new AnthropicLlmClient(opts),
  },
};

export const DEFAULT_PROVIDER: LlmProviderId = "anthropic";

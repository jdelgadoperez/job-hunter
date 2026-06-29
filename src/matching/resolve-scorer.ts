import type { Scorer, Warning } from "@app/domain/types";
import { HeuristicScorer } from "./heuristic-scorer";
import type { LlmClient } from "./llm-client";
import type { LlmProviderConfig } from "./llm-providers";
import { LlmScorer } from "./llm-scorer";
import {
  resolveApiKey,
  resolveProvider,
  resolveScorerModel,
  type SettingsReader,
} from "./resolve-settings";

const WARNING_SOURCE = "llm-scorer";

export type ResolveScorerDeps = {
  settings: SettingsReader;
  /** Skill dictionary for the heuristic scorer (used directly when no key, and as fallback). */
  dictionary?: string[];
  onWarning?: (warning: Warning) => void;
  /** Override the provider's client factory — injected so the factory is testable offline. */
  clientOverride?: (
    provider: LlmProviderConfig,
    opts: { apiKey: string; model: string },
  ) => LlmClient;
};

/**
 * Choose a `Scorer` from settings. With no API key configured for the active provider, return
 * the free `HeuristicScorer` and emit one `Warning`. With a key, return an `LlmScorer` (heuristic
 * fallback) wired to the resolved provider and model.
 */
export function resolveScorer(deps: ResolveScorerDeps): Scorer {
  const { settings, dictionary, onWarning, clientOverride } = deps;
  const provider = resolveProvider(settings);
  const apiKey = resolveApiKey(settings, provider);

  if (!apiKey) {
    onWarning?.({
      source: WARNING_SOURCE,
      message: `no API key configured for ${provider.id}; using the free heuristic scorer`,
    });
    return new HeuristicScorer(dictionary);
  }

  const model = resolveScorerModel(settings, provider);
  const client = clientOverride
    ? clientOverride(provider, { apiKey, model })
    : provider.createClient({ apiKey, model });
  return new LlmScorer(client, new HeuristicScorer(dictionary), onWarning);
}

import type { JobPosting, MatchResult, Scorer, SkillProfile, Warning } from "@app/domain/types";
import { errorMessage } from "@app/net/error-message";
import type { LlmClient } from "./llm-client";
import { MatchPayloadSchema } from "./llm-schema";
import { buildScorePrompt, toMatchResult } from "./score-prompt";
import { isUsageLimitError } from "./usage-limit-error";

const WARNING_SOURCE = "llm-scorer";

/**
 * A `Scorer` for the deep-score pass (`runScoreRun`). Unlike `LlmScorer`, it does NOT degrade a
 * usage-limit error to the heuristic — it re-throws it, so `runScoreRun` can abort the whole run
 * rather than silently burning through a hard limit one heuristic fallback at a time. Ordinary
 * failures (network blips, malformed payloads) still degrade to the heuristic with a warning.
 *
 * Shared by the CLI (`score` command) and the web server (`createScoreRunner`) so the abort
 * semantics can't drift between the two entry points.
 */
export function createAbortingScorer(deps: {
  client: LlmClient;
  heuristic: Scorer;
  remoteOnly: boolean;
  onWarning: (warning: Warning) => void;
}): Scorer {
  const { client, heuristic, remoteOnly, onWarning } = deps;
  return {
    score: async (profile: SkillProfile, posting: JobPosting): Promise<MatchResult> => {
      try {
        const payload = await client.score(buildScorePrompt(profile, posting, remoteOnly));
        const parsed = MatchPayloadSchema.safeParse(payload);
        if (!parsed.success) return heuristic.score(profile, posting);
        return toMatchResult(parsed.data);
      } catch (error) {
        if (isUsageLimitError(error)) throw error; // let score-run abort the whole run
        onWarning({
          source: WARNING_SOURCE,
          message: `LLM scoring failed: ${errorMessage(error)}; using the heuristic scorer`,
        });
        return heuristic.score(profile, posting);
      }
    },
  };
}

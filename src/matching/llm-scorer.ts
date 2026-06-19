import type { JobPosting, MatchResult, Scorer, SkillProfile, Warning } from "@app/domain/types";
import type { LlmClient } from "./llm-client";
import { MatchPayloadSchema } from "./llm-schema";
import { buildScorePrompt, toMatchResult } from "./score-prompt";

const WARNING_SOURCE = "llm-scorer";

/**
 * `Scorer` backed by a hosted LLM, with a heuristic fallback. On any failure — API error,
 * refusal, or a payload that fails zod validation — it returns the fallback scorer's result
 * and emits a `Warning` (so the user can see LLM scoring was unavailable) rather than throwing.
 * `score` never rejects.
 *
 * The `Scorer` interface is unchanged; warnings flow through the injected `onWarning` callback.
 */
export class LlmScorer implements Scorer {
  constructor(
    private readonly llm: LlmClient,
    private readonly fallback: Scorer,
    private readonly onWarning?: (warning: Warning) => void,
  ) {}

  async score(profile: SkillProfile, posting: JobPosting): Promise<MatchResult> {
    try {
      const payload = await this.llm.score(buildScorePrompt(profile, posting));
      // Re-validate at the boundary: belt-and-suspenders over the SDK's own validation, and
      // the real validation point when a non-SDK client (or test double) supplies the payload.
      const parsed = MatchPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        return this.degrade(profile, posting, "LLM returned a malformed payload");
      }
      return toMatchResult(parsed.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.degrade(profile, posting, `LLM scoring failed: ${message}`);
    }
  }

  private async degrade(
    profile: SkillProfile,
    posting: JobPosting,
    message: string,
  ): Promise<MatchResult> {
    this.onWarning?.({ source: WARNING_SOURCE, message: `${message}; using the heuristic scorer` });
    return this.fallback.score(profile, posting);
  }
}

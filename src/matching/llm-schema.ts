import { z } from "zod";

/**
 * The shape every LLM scorer engine must return, validated at the boundary with zod
 * before it becomes a `MatchResult`. A payload that fails this schema is treated exactly
 * like an API failure: the `LlmScorer` degrades to the heuristic and emits a `Warning`,
 * never a thrown error that aborts scoring.
 *
 * `.strict()` disallows unknown keys, which also satisfies the structured-output
 * requirement that every object set `additionalProperties: false`.
 */
export const MatchPayloadSchema = z
  .object({
    score: z.number().min(0).max(100),
    matchedSkills: z.array(z.string()),
    missingSkills: z.array(z.string()),
    rationale: z.string(),
  })
  .strict();

export type LlmMatchPayload = z.infer<typeof MatchPayloadSchema>;

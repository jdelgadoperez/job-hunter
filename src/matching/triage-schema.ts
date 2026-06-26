import { z } from "zod";

/**
 * One keep/drop verdict per title in a triage batch. `.strict()` disallows unknown keys (also
 * satisfies the structured-output requirement that objects set `additionalProperties: false`).
 */
export const TriageDecisionSchema = z
  .object({
    id: z.string(),
    keep: z.boolean(),
    reason: z.string(),
  })
  .strict();

export const TriagePayloadSchema = z
  .object({
    decisions: z.array(TriageDecisionSchema),
  })
  .strict();

export type LlmTriagePayload = z.infer<typeof TriagePayloadSchema>;

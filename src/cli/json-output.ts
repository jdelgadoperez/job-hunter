import type { ScoreOutcome } from "@app/matching/score-run";
import type { ScoredPosting } from "@app/storage/repository";
import { z } from "zod";

/** The stable `list --json` record shape — a flattened, JSON-safe view of a scored posting. */
export const MatchJsonSchema = z.object({
  score: z.number(),
  company: z.string(),
  title: z.string(),
  url: z.string(),
  source: z.string(),
  location: z.string().nullable(),
  remote: z.boolean(),
  country: z.string().nullable(),
  postedAt: z.string().nullable(),
  applied: z.boolean(),
  expired: z.boolean(),
});
export type MatchJson = z.infer<typeof MatchJsonSchema>;

/** Flatten `listScoredPostings` rows into the `list --json` array contract. */
export function toMatchJson(rows: ScoredPosting[]): MatchJson[] {
  return rows.map(({ posting, result, action, expired }) => ({
    score: result.score,
    company: posting.company,
    title: posting.title,
    url: posting.url,
    source: posting.source,
    location: posting.location ?? null,
    remote: posting.remote ?? false,
    country: posting.country ?? null,
    postedAt: posting.postedAt ? posting.postedAt.toISOString() : null,
    applied: action === "applied",
    expired,
  }));
}

/** `score --json` emits the run summary object as-is; this schema documents/validates its shape. */
export const ScoreOutcomeJsonSchema = z.object({
  counts: z.object({
    inDb: z.number(),
    afterRemote: z.number(),
    afterHeuristic: z.number(),
    afterCap: z.number(),
    alreadyScoredSkipped: z.number(),
    triageTitles: z.number(),
    deepScored: z.number(),
    remotePenalized: z.number(),
    locationPenalized: z.number(),
  }),
  estimate: z.object({
    triageTitles: z.number(),
    triageBatches: z.number(),
    deepScores: z.number(),
    triageUsd: z.number(),
    deepScoreUsd: z.number(),
    totalUsd: z.number(),
  }),
  warnings: z.array(
    z.object({ source: z.string(), message: z.string(), careersUrl: z.string().optional() }),
  ),
  abortedOnLimit: z.boolean(),
}) satisfies z.ZodType<ScoreOutcome>;

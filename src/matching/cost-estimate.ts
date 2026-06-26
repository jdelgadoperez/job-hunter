export type CostEstimate = {
  triageTitles: number;
  triageBatches: number;
  deepScores: number;
  triageUsd: number;
  deepScoreUsd: number;
  totalUsd: number;
};

/**
 * Pure cost estimate for a `score` run. A labeled approximation for the dry-run preview, never a
 * billing guarantee. `triageBatches` is the number of LLM triage calls (titles / batchSize, ceil).
 */
export function estimateCost(opts: {
  triageTitles: number;
  deepScores: number;
  batchSize: number;
  cost: { perTriageTitleUsd: number; perDeepScoreUsd: number };
}): CostEstimate {
  const { triageTitles, deepScores, batchSize, cost } = opts;
  const triageBatches = triageTitles === 0 ? 0 : Math.ceil(triageTitles / batchSize);
  const triageUsd = triageTitles * cost.perTriageTitleUsd;
  const deepScoreUsd = deepScores * cost.perDeepScoreUsd;
  return {
    triageTitles,
    triageBatches,
    deepScores,
    triageUsd,
    deepScoreUsd,
    totalUsd: triageUsd + deepScoreUsd,
  };
}

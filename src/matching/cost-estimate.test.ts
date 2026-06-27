import { describe, expect, it } from "vitest";
import { estimateCost } from "./cost-estimate";

const cost = { perTriageTitleUsd: 0.002, perDeepScoreUsd: 0.03 };

describe("estimateCost", () => {
  it("counts batches by ceiling-dividing titles by batch size", () => {
    const estimate = estimateCost({ triageTitles: 82, deepScores: 82, batchSize: 40, cost });
    expect(estimate.triageBatches).toBe(Math.ceil(82 / 40));
  });

  it("derives each line and the total from the inputs and rates", () => {
    const triageTitles = 50;
    const deepScores = 30;
    const estimate = estimateCost({ triageTitles, deepScores, batchSize: 40, cost });

    expect(estimate.triageUsd).toBeCloseTo(triageTitles * cost.perTriageTitleUsd);
    expect(estimate.deepScoreUsd).toBeCloseTo(deepScores * cost.perDeepScoreUsd);
    expect(estimate.totalUsd).toBeCloseTo(estimate.triageUsd + estimate.deepScoreUsd);
  });

  it("is zero across the board for an empty plan", () => {
    const estimate = estimateCost({ triageTitles: 0, deepScores: 0, batchSize: 40, cost });
    expect(estimate.triageBatches).toBe(0);
    expect(estimate.totalUsd).toBe(0);
  });
});

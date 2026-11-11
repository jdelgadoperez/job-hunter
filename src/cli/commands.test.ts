import type { ScoreOutcome } from "@app/matching/score-run";
import { describe, expect, it } from "vitest";
import { formatScorePlan } from "./commands";

function outcome(overrides: Partial<ScoreOutcome["counts"]> = {}): ScoreOutcome {
  const counts = {
    inDb: 200,
    afterRemote: 120,
    afterHeuristic: 200,
    afterCap: 100,
    alreadyScoredSkipped: 18,
    triageTitles: 82,
    deepScored: 0,
    remotePenalized: 0,
    locationPenalized: 0,
    ...overrides,
  };
  return {
    counts,
    estimate: {
      triageTitles: counts.triageTitles,
      triageBatches: 3,
      deepScores: counts.triageTitles,
      triageUsd: 0.16,
      deepScoreUsd: 2.46,
      totalUsd: 2.62,
    },
    warnings: [],
    abortedOnLimit: false,
  };
}

describe("formatScorePlan", () => {
  it("shows the db total, cap, skipped count, and estimated total for a dry run", () => {
    const result = outcome();
    const text = formatScorePlan(result, { remoteOnly: true, limit: 100, dryRun: true });
    expect(text).toContain(String(result.counts.inDb));
    expect(text).toContain("100");
    expect(text).toContain("18");
    expect(text).toContain("2.62");
  });

  it("reports how many were deep-scored after a real run", () => {
    const text = formatScorePlan(outcome({ deepScored: 80 }), {
      remoteOnly: false,
      limit: 100,
      dryRun: false,
    });
    expect(text).toContain("80");
  });

  it("reports the non-remote penalized count when remote-only penalizes postings", () => {
    const text = formatScorePlan(outcome({ remotePenalized: 25 }), {
      remoteOnly: true,
      limit: 100,
      dryRun: false,
    });
    expect(text).toContain("25");
    expect(text).toMatch(/non-remote/i);
  });

  it("omits the non-remote line when nothing was penalized", () => {
    const text = formatScorePlan(outcome({ remotePenalized: 0 }), {
      remoteOnly: false,
      limit: 100,
      dryRun: false,
    });
    expect(text).not.toMatch(/non-remote/i);
  });

  it("lists the already-scored skip before the cap, matching the pipeline order", () => {
    // already-scored postings are dropped BEFORE the limit is applied, so the plan must read as a
    // coherent decreasing funnel (skip, then cap the remainder) rather than cap-then-skip, which
    // implies more postings were considered than actually fit the cap window.
    const text = formatScorePlan(outcome(), { remoteOnly: false, limit: 100, dryRun: true });
    const skippedAt = text.indexOf("Already LLM-scored");
    const cappedAt = text.indexOf("Cap (--limit");
    expect(skippedAt).toBeGreaterThan(-1);
    expect(cappedAt).toBeGreaterThan(-1);
    expect(skippedAt).toBeLessThan(cappedAt);
  });
});

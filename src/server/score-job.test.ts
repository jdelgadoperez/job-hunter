import type { CostEstimate } from "@app/matching/cost-estimate";
import type { ScoreStageCounts } from "@app/matching/score-run";
import { describe, expect, it } from "vitest";
import { ScoreJobManager, type ScoreResult } from "./score-job";
import type { ScoreRunner } from "./types";

function counts(overrides: Partial<ScoreStageCounts> = {}): ScoreStageCounts {
  return {
    inDb: 0,
    afterRemote: 0,
    afterHeuristic: 0,
    afterCap: 0,
    alreadyScoredSkipped: 0,
    triageTitles: 0,
    deepScored: 0,
    remotePenalized: 0,
    ...overrides,
  };
}

const estimate: CostEstimate = {
  triageTitles: 0,
  triageBatches: 0,
  deepScores: 0,
  triageUsd: 0,
  deepScoreUsd: 0,
  totalUsd: 0,
};

/** A runner whose completion the test controls, to observe the `running` state deterministically. */
function deferredRunner(): {
  runner: ScoreRunner;
  resolve: (result: ScoreResult) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (result: ScoreResult) => void;
  let reject!: (e: Error) => void;
  const gate = new Promise<ScoreResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const runner: ScoreRunner = async () => gate;
  return { runner, resolve, reject };
}

describe("ScoreJobManager", () => {
  it("starts idle", () => {
    expect(new ScoreJobManager().getStatus().state).toBe("idle");
    expect(new ScoreJobManager().isRunning()).toBe(false);
  });

  it("transitions idle → running → done with the final counts", async () => {
    const jobs = new ScoreJobManager();
    const { runner, resolve } = deferredRunner();

    expect(jobs.start(runner)).toBe(true);
    expect(jobs.getStatus().state).toBe("running");
    expect(jobs.getStatus().startedAt).not.toBeNull();

    resolve({ counts: counts({ deepScored: 5 }), estimate, warnings: [], abortedOnLimit: false });
    await new Promise((r) => setTimeout(r, 0));

    const status = jobs.getStatus();
    expect(status.state).toBe("done");
    expect(status.counts?.deepScored).toBe(5);
    expect(status.message).toContain("Deep-scored 5");
    expect(status.finishedAt).not.toBeNull();
  });

  it("surfaces abortedOnLimit and warnings from the outcome", async () => {
    const jobs = new ScoreJobManager();
    const { runner, resolve } = deferredRunner();
    jobs.start(runner);

    resolve({
      counts: counts({ deepScored: 2 }),
      estimate,
      warnings: [{ source: "score", message: "hit the provider usage limit" }],
      abortedOnLimit: true,
    });
    await new Promise((r) => setTimeout(r, 0));

    const status = jobs.getStatus();
    expect(status.abortedOnLimit).toBe(true);
    expect(status.warnings).toHaveLength(1);
  });

  it("transitions to error when the runner rejects", async () => {
    const jobs = new ScoreJobManager();
    const { runner, reject } = deferredRunner();
    jobs.start(runner);

    reject(new Error("no key"));
    await new Promise((r) => setTimeout(r, 0));

    const status = jobs.getStatus();
    expect(status.state).toBe("error");
    expect(status.error).toBe("no key");
  });

  it("is single-flight: start() returns false while running", async () => {
    const jobs = new ScoreJobManager();
    const { runner, resolve } = deferredRunner();

    expect(jobs.start(runner)).toBe(true);
    expect(jobs.start(deferredRunner().runner)).toBe(false);

    resolve({ counts: counts(), estimate, warnings: [], abortedOnLimit: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(jobs.start(deferredRunner().runner)).toBe(true);
  });

  it("carries the latest stage message", async () => {
    const jobs = new ScoreJobManager();
    const runner: ScoreRunner = async (onStage) => {
      onStage("Triaging 10 titles…");
      onStage("Deep-scoring…");
      return { counts: counts(), estimate, warnings: [], abortedOnLimit: false };
    };
    jobs.start(runner);
    // Message is observable synchronously before the microtask completes, but assert post-settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(jobs.getStatus().message).toContain("Deep-scored");
  });

  it("returns copies so callers can't mutate internal state", () => {
    const jobs = new ScoreJobManager();
    jobs.getStatus().warnings.push({ source: "x", message: "y" });
    expect(jobs.getStatus().warnings).toHaveLength(0);
  });
});

import type { ScoreProgressEvent } from "@app/domain/score-progress";
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
    locationPenalized: 0,
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

/**
 * A runner that captures its `onProgress` callback so the test can `emit(event)` synchronously and
 * observe the resulting status, then `resolve` completion. `start()` invokes the runner
 * synchronously, so `onProgress` is captured before the first `emit` call.
 */
function progressRunner(): {
  runner: ScoreRunner;
  resolve: (result: ScoreResult) => void;
  emit: (event: ScoreProgressEvent) => void;
} {
  let resolve!: (result: ScoreResult) => void;
  let onProgress: ((event: ScoreProgressEvent) => void) | undefined;
  const gate = new Promise<ScoreResult>((res) => {
    resolve = res;
  });
  const runner: ScoreRunner = async (cb) => {
    onProgress = cb;
    return gate;
  };
  const emit = (event: ScoreProgressEvent) => {
    if (!onProgress) throw new Error("runner not started");
    onProgress(event);
  };
  return { runner, resolve, emit };
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

  it("tracks current/total/recent from scoring progress events", async () => {
    const jobs = new ScoreJobManager();
    const { runner, resolve, emit } = progressRunner();
    jobs.start(runner);

    emit({ kind: "triaging", total: 3 });
    expect(jobs.getStatus().total).toBe(3);

    emit({ kind: "scoring", index: 1, total: 3, title: "Alpha" });
    emit({ kind: "scoring", index: 2, total: 3, title: "Beta" });
    let status = jobs.getStatus();
    expect(status.current).toBe(2);
    expect(status.total).toBe(3);
    expect(status.recent).toEqual(["[1/3] Alpha", "[2/3] Beta"]);
    expect(status.message).toBe("[2/3] Beta");

    resolve({ counts: counts({ deepScored: 2 }), estimate, warnings: [], abortedOnLimit: false });
    await new Promise((r) => setTimeout(r, 0));
    status = jobs.getStatus();
    expect(status.state).toBe("done");
    expect(status.message).toContain("Deep-scored 2");
  });

  it("updates total to the kept count on triaged, before scoring starts", async () => {
    // Guards against a progress-bar denominator jump: triaging reports the pre-triage count, but the
    // bar should switch to the post-triage survivor count as soon as triage finishes — not snap to it
    // only when the first score lands.
    const jobs = new ScoreJobManager();
    const { runner, emit } = progressRunner();
    jobs.start(runner);

    emit({ kind: "triaging", total: 100 });
    expect(jobs.getStatus().total).toBe(100);

    emit({ kind: "triaged", kept: 20, total: 100 });
    const status = jobs.getStatus();
    expect(status.total).toBe(20);
    expect(status.current).toBe(0);
  });

  it("caps the recent list at 8 entries", async () => {
    const jobs = new ScoreJobManager();
    const { runner, resolve, emit } = progressRunner();
    jobs.start(runner);

    const total = 12;
    for (let i = 1; i <= total; i++) {
      emit({ kind: "scoring", index: i, total, title: `Job ${i}` });
    }
    const status = jobs.getStatus();
    expect(status.recent).toHaveLength(8);
    // Newest last: the final entry is the most recent tick.
    expect(status.recent.at(-1)).toBe(`[${total}/${total}] Job ${total}`);
    expect(status.current).toBe(total);

    resolve({
      counts: counts({ deepScored: total }),
      estimate,
      warnings: [],
      abortedOnLimit: false,
    });
    await new Promise((r) => setTimeout(r, 0));
  });

  it("returns copies so callers can't mutate internal state", () => {
    const jobs = new ScoreJobManager();
    jobs.getStatus().warnings.push({ source: "x", message: "y" });
    expect(jobs.getStatus().warnings).toHaveLength(0);
  });
});

import type { Warning } from "@app/domain/types";
import type { CostEstimate } from "@app/matching/cost-estimate";
import type { ScoreStageCounts } from "@app/matching/score-run";
import { errorMessage } from "@app/net/error-message";
import type { ScoreRunner } from "./types";

export type ScoreJobState = "idle" | "running" | "done" | "error";

/** A serializable snapshot of the background deep-score, polled via `GET /api/score/status`. */
export type ScoreJobStatus = {
  state: ScoreJobState;
  /** Latest human-readable stage line ("Triaging…", "Deep-scoring…"), or null before the first run. */
  message: string | null;
  /** Per-stage counts, set when a run finishes. */
  counts: ScoreStageCounts | null;
  /** Cost estimate for the run, set when a run finishes. */
  estimate: CostEstimate | null;
  /** True when the run stopped early after hitting the provider's usage/rate limit. */
  abortedOnLimit: boolean;
  warnings: Warning[];
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

/** What a deep-score runner returns when it finishes. */
export type ScoreResult = {
  counts: ScoreStageCounts;
  estimate: CostEstimate;
  warnings: Warning[];
  abortedOnLimit: boolean;
};

function idleStatus(): ScoreJobStatus {
  return {
    state: "idle",
    message: null,
    counts: null,
    estimate: null,
    abortedOnLimit: false,
    warnings: [],
    error: null,
    startedAt: null,
    finishedAt: null,
  };
}

/**
 * Runs deep-score passes in the background, one at a time, exposing a pollable status snapshot.
 * Mirrors `ScanJobManager`: single-flight, server-held state so the UI can navigate away and poll
 * back. Pure orchestration — the actual LLM pipeline is the injected `ScoreRunner` — so it's
 * unit-tested against a fake runner with no live provider.
 */
export class ScoreJobManager {
  private status: ScoreJobStatus = idleStatus();

  getStatus(): ScoreJobStatus {
    return {
      ...this.status,
      counts: this.status.counts ? { ...this.status.counts } : null,
      estimate: this.status.estimate ? { ...this.status.estimate } : null,
      warnings: [...this.status.warnings],
    };
  }

  isRunning(): boolean {
    return this.status.state === "running";
  }

  /** Start a deep-score in the background. Returns false (unchanged) if one is already running. */
  start(runner: ScoreRunner): boolean {
    if (this.status.state === "running") return false;
    this.status = {
      ...idleStatus(),
      state: "running",
      message: "Starting…",
      startedAt: new Date().toISOString(),
    };
    void this.run(runner);
    return true;
  }

  private async run(runner: ScoreRunner): Promise<void> {
    try {
      const result = await runner((message) => this.onStage(message));
      this.status = {
        ...this.status,
        state: "done",
        counts: result.counts,
        estimate: result.estimate,
        warnings: result.warnings,
        abortedOnLimit: result.abortedOnLimit,
        message: `Deep-scored ${result.counts.deepScored} posting(s)`,
        finishedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.status = {
        ...this.status,
        state: "error",
        error: errorMessage(error),
        finishedAt: new Date().toISOString(),
      };
    }
  }

  private onStage(message: string): void {
    this.status = { ...this.status, message };
  }
}

import { formatScoreProgress, type ScoreProgressEvent } from "@app/domain/score-progress";
import type { Warning } from "@app/domain/types";
import type { CostEstimate } from "@app/matching/cost-estimate";
import type { ScoreStageCounts } from "@app/matching/score-run";
import { errorMessage } from "@app/net/error-message";
import type { ScoreRunner } from "./types";

export type ScoreJobState = "idle" | "running" | "done" | "error";

/** A serializable snapshot of the background deep-score, polled via `GET /api/score/status`. */
export type ScoreJobStatus = {
  state: ScoreJobState;
  /** Latest human-readable stage line ("Triaging…", "[42/118] …"), or null before the first run. */
  message: string | null;
  /** Postings deep-scored so far / total to deep-score, when known (drives the UI progress bar). */
  current: number | null;
  total: number | null;
  /** The most recent scored-posting lines (newest last), for a rolling activity view. */
  recent: string[];
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

/** How many recent scored-posting lines to retain for the rolling list (matches scan-job). */
const MAX_RECENT = 8;

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
    current: null,
    total: null,
    recent: [],
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
      recent: [...this.status.recent],
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
      const result = await runner((event) => this.onProgress(event));
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

  private onProgress(event: ScoreProgressEvent): void {
    this.status = { ...this.status, message: formatScoreProgress(event) };
    if (event.kind === "triaging") this.status.total = event.total;
    if (event.kind === "scoring") {
      this.status.current = event.index;
      this.status.total = event.total;
      this.status.recent = [...this.status.recent, formatScoreProgress(event)].slice(-MAX_RECENT);
    }
  }
}

import { type ScanProgressEvent, formatProgress } from "@app/domain/scan-progress";
import type { Warning } from "@app/domain/types";
import type { ScanRunner } from "./types";

export type ScanJobState = "idle" | "running" | "done" | "error";

/** A serializable snapshot of the background scan, polled by the CLI/UI via `GET /api/scan/status`. */
export type ScanJobStatus = {
  state: ScanJobState;
  /** Latest human-readable status line, or null before the first run. */
  message: string | null;
  /** Companies visited / total, when known. */
  current: number | null;
  total: number | null;
  /** Postings scored, set when a run finishes successfully. */
  count: number | null;
  warnings: Warning[];
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** The most recent companies visited (newest last), for a rolling activity view. */
  recent: string[];
};

/** How many recent company lines to retain for the rolling list. */
const MAX_RECENT = 8;

function idleStatus(): ScanJobStatus {
  return {
    state: "idle",
    message: null,
    current: null,
    total: null,
    count: null,
    warnings: [],
    error: null,
    startedAt: null,
    finishedAt: null,
    recent: [],
  };
}

/**
 * Runs scans in the background, one at a time, exposing a pollable status snapshot. Holding scan
 * state on the server (rather than streaming it to one client) lets the UI navigate away and come
 * back, and lets a scheduled refresh and a manual "Scan now" share the same single-flight job.
 * Pure orchestration — the actual pipeline is the injected `ScanRunner` — so it's unit-tested.
 */
export class ScanJobManager {
  private status: ScanJobStatus = idleStatus();

  getStatus(): ScanJobStatus {
    return {
      ...this.status,
      warnings: [...this.status.warnings],
      recent: [...this.status.recent],
    };
  }

  isRunning(): boolean {
    return this.status.state === "running";
  }

  /**
   * Start a scan in the background. Returns false (and changes nothing) if one is already running,
   * so a manual trigger and the scheduler never overlap.
   */
  start(runner: ScanRunner): boolean {
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

  private async run(runner: ScanRunner): Promise<void> {
    try {
      const result = await runner((event) => this.onProgress(event));
      this.status = {
        ...this.status,
        state: "done",
        count: result.count,
        warnings: result.warnings,
        message: formatProgress({ kind: "summary", count: result.count }),
        finishedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.status = {
        ...this.status,
        state: "error",
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date().toISOString(),
      };
    }
  }

  private onProgress(event: ScanProgressEvent): void {
    this.status = { ...this.status, message: formatProgress(event) };
    if (event.kind === "leads") this.status.total = event.total;
    if (event.kind === "company") {
      this.status.current = event.index;
      this.status.total = event.total;
      // Keep a rolling tail of the companies most recently visited.
      this.status.recent = [...this.status.recent, formatProgress(event)].slice(-MAX_RECENT);
    }
  }
}

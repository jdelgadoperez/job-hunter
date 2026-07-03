import type { ScanProgressEvent } from "@app/domain/scan-progress";
import type { ScoreProgressEvent } from "@app/domain/score-progress";
import type { SkillProfile, Warning } from "@app/domain/types";
import type { UpdateStatus } from "@app/runtime/version";
import type { Repository } from "@app/storage/repository";
import type { ScanJobManager } from "./scan-job";
import type { ScoreJobManager, ScoreResult } from "./score-job";

/** Summary returned when a scan finishes. */
export type ScanSummary = { count: number; warnings: Warning[] };

/**
 * The scan seam the server depends on. Production wires this to the real discovery + scoring
 * pipeline (browser + network, so smoke-only); tests inject a fake that emits canned progress.
 * Mirrors the `Fetcher`/`LlmClient` dependency-injection pattern used across the codebase.
 */
export type ScanRunner = (onProgress: (event: ScanProgressEvent) => void) => Promise<ScanSummary>;

/** Options for a deep-score run, surfaced from the dashboard. */
export type ScoreRunOptions = { remoteOnly: boolean; limit: number; rescore: boolean };

/**
 * The deep-score seam. Production wires this to the real LLM pipeline (`runScoreRun`), so it's
 * smoke-only; tests inject a fake. `onProgress` carries the structured `ScoreProgressEvent` stream
 * (planning → triaging → per-posting scoring ticks → done) for the job status + terminal log, the
 * same way `ScanRunner` carries `ScanProgressEvent`. Returns the outcome the job manager snapshots.
 */
export type ScoreRunner = (onProgress: (event: ScoreProgressEvent) => void) => Promise<ScoreResult>;

/** Everything `createApp` needs, all injectable so route handlers are unit-tested offline. */
export type ServerDeps = {
  repo: Repository;
  /** Background scan-job manager (start + status). */
  jobs: ScanJobManager;
  /** Build a scan runner for the given scope (`"full"` or `"incremental"`). */
  runScanForScope: (scope: "full" | "incremental") => ScanRunner;
  /** The scan to run for `POST /api/scan/retry-failed` — scoped to the needs-attention list. */
  retryFailedScan: ScanRunner;
  /** Background deep-score-job manager (start + status). */
  scoreJobs: ScoreJobManager;
  /** Build a deep-score runner for the given options (resolves provider/key/model). */
  createScoreRun: (options: ScoreRunOptions) => ScoreRunner;
  /** Synchronous dry-run: the plan + cost estimate for a deep-score, with zero LLM calls. */
  previewScore: (options: ScoreRunOptions) => Promise<ScoreResult>;
  /** Build a profile from raw resume text (wraps the domain builder + skill dictionary). */
  buildProfileFromText: (resumeText: string) => SkillProfile;
  /** Installed version + whether a newer one is available (best-effort, cached). */
  getUpdateStatus: () => Promise<UpdateStatus>;
};

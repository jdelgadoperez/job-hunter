import type { ScanProgressEvent } from "@app/domain/scan-progress";
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
export type ScoreRunOptions = { remoteOnly: boolean; limit: number };

/**
 * The deep-score seam. Production wires this to the real LLM pipeline (`runScoreRun`), so it's
 * smoke-only; tests inject a fake. `onStage` carries coarse progress lines for the job status
 * (the LLM pipeline has no per-item progress). Returns the outcome the job manager snapshots.
 */
export type ScoreRunner = (onStage: (message: string) => void) => Promise<ScoreResult>;

/** Everything `createApp` needs, all injectable so route handlers are unit-tested offline. */
export type ServerDeps = {
  repo: Repository;
  /** Background scan-job manager (start + status). */
  jobs: ScanJobManager;
  /** The scan to run when a job starts. */
  runScan: ScanRunner;
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

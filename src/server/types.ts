import type { ScanProgressEvent } from "@app/domain/scan-progress";
import type { SkillProfile, Warning } from "@app/domain/types";
import type { Repository } from "@app/storage/repository";
import type { ScanJobManager } from "./scan-job";

/** Summary returned when a scan finishes. */
export type ScanSummary = { count: number; warnings: Warning[] };

/**
 * The scan seam the server depends on. Production wires this to the real discovery + scoring
 * pipeline (browser + network, so smoke-only); tests inject a fake that emits canned progress.
 * Mirrors the `Fetcher`/`LlmClient` dependency-injection pattern used across the codebase.
 */
export type ScanRunner = (onProgress: (event: ScanProgressEvent) => void) => Promise<ScanSummary>;

/** Everything `createApp` needs, all injectable so route handlers are unit-tested offline. */
export type ServerDeps = {
  repo: Repository;
  /** Background scan-job manager (start + status). */
  jobs: ScanJobManager;
  /** The scan to run when a job starts. */
  runScan: ScanRunner;
  /** Build a profile from raw resume text (wraps the domain builder + skill dictionary). */
  buildProfileFromText: (resumeText: string) => SkillProfile;
};

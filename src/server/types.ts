import type { SkillProfile, Warning } from "@app/domain/types";
import type { Repository } from "@app/storage/repository";

/** A progress event streamed over SSE while a scan runs. */
export type ScanProgress =
  | { phase: "start" }
  | { phase: "log"; message: string }
  | { phase: "done"; count: number; warnings: Warning[] }
  | { phase: "error"; message: string };

/** Summary returned when a scan finishes. */
export type ScanSummary = { count: number; warnings: Warning[] };

/**
 * The scan seam the web app depends on. Production wires this to the real discovery + scoring
 * pipeline (browser + network, so smoke-only); tests inject a fake that emits canned progress.
 * Mirrors the `Fetcher`/`LlmClient` dependency-injection pattern used across the codebase.
 */
export type ScanRunner = (onProgress: (event: ScanProgress) => void) => Promise<ScanSummary>;

/** Everything `createApp` needs, all injectable so route handlers are unit-tested offline. */
export type ServerDeps = {
  repo: Repository;
  runScan: ScanRunner;
  /** Build a profile from raw resume text (wraps the domain builder + skill dictionary). */
  buildProfileFromText: (resumeText: string) => SkillProfile;
};

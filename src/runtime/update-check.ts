import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type UpdateStatus, getVersion, toUpdateStatus } from "./version";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const exec = promisify(execFile);

/**
 * Best-effort count of how many commits the local checkout is behind the remote default branch.
 * Returns null when it can't be determined (not a git checkout, offline, no upstream, etc.) so the
 * UI simply shows no nudge rather than a false one. Integration-bound (git + network) — not unit
 * tested; the pure interpretation lives in `version.ts`.
 */
async function commitsBehindRemote(): Promise<number | null> {
  try {
    await exec("git", ["-C", ROOT, "fetch", "--quiet", "origin"], { timeout: 15_000 });
    const { stdout } = await exec("git", ["-C", ROOT, "rev-list", "--count", "HEAD..origin/main"], {
      timeout: 5_000,
    });
    const behind = Number(stdout.trim());
    return Number.isFinite(behind) ? behind : null;
  } catch {
    return null;
  }
}

/** The installed version plus whether the remote has newer commits (best-effort). */
export async function getUpdateStatus(): Promise<UpdateStatus> {
  return toUpdateStatus(getVersion(), await commitsBehindRemote());
}

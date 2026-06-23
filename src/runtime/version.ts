import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, relative to this file (src/runtime/version.ts). */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type UpdateStatus = {
  /** The installed version, from package.json. */
  version: string;
  /** Commits the local checkout is behind the remote default branch; null when it can't be determined. */
  behind: number | null;
  updateAvailable: boolean;
};

/** The installed version from package.json, or "0.0.0" if it can't be read. */
export function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Pure: turn a commits-behind count (or null = unknown) into an update status. */
export function toUpdateStatus(version: string, behind: number | null): UpdateStatus {
  return { version, behind, updateAvailable: behind !== null && behind > 0 };
}

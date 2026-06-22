import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Env var that overrides the data directory on any platform. */
export const DATA_DIR_ENV = "JOB_HUNTER_HOME";

const DB_FILENAME = "jobhunter.db";

export type PathOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
};

/**
 * Where the app keeps its SQLite DB and any local state. Cross-platform: `JOB_HUNTER_HOME`
 * overrides everything; otherwise `%APPDATA%\job-hunter` on Windows (home dir if APPDATA is
 * missing) and `~/.job-hunter` on macOS/Linux. Platform/env/home are injectable for testing.
 */
export function resolveDataDir(opts: PathOptions = {}): string {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.homedir ?? homedir();

  const override = env[DATA_DIR_ENV]?.trim();
  if (override) return override;

  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    return join(appData && appData.length > 0 ? appData : home, "job-hunter");
  }
  return join(home, ".job-hunter");
}

/** Absolute path to the SQLite database file. */
export function resolveDbPath(opts: PathOptions = {}): string {
  return join(resolveDataDir(opts), DB_FILENAME);
}

/** Create the data directory (recursively) if needed and return it. */
export function ensureDataDir(opts: PathOptions = {}): string {
  const dir = resolveDataDir(opts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

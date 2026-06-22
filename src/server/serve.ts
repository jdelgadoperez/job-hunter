import { spawn } from "node:child_process";
import { buildProfile } from "@app/profile/build-profile";
import { ensureDataDir, resolveDbPath } from "@app/runtime/paths";
import { Repository } from "@app/storage/repository";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { createScanRunner } from "./scan-runner";

export type ServeOptions = {
  /** Port to listen on. Defaults to 4317. */
  port?: number;
  /** Open the dashboard in the default browser on launch. Defaults to true. */
  open?: boolean;
};

const DEFAULT_PORT = 4317;

/** Best-effort, cross-platform "open this URL in the default browser". Never throws. */
function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // Opening a browser is a convenience, not a requirement — the URL is logged regardless.
  }
}

/**
 * Start the local web dashboard: open the SQLite-backed `Repository`, build the Hono app with the
 * real scan pipeline, and listen. Binds a port and launches a browser, so this is the integration
 * seam — `createApp` holds the unit-tested logic. Runs until the process is stopped.
 */
export function startServer(opts: ServeOptions = {}): void {
  ensureDataDir();
  const repo = new Repository(resolveDbPath());

  const app = createApp({
    repo,
    runScan: createScanRunner(repo),
    buildProfileFromText: (resumeText) => {
      const dictionary = repo.getSkillDictionary();
      return buildProfile({
        resumeText,
        dictionary: dictionary.length > 0 ? dictionary : undefined,
      });
    },
  });

  const port = opts.port ?? DEFAULT_PORT;
  serve({ fetch: app.fetch, port }, (info) => {
    const url = `http://localhost:${info.port}`;
    console.log(`job-hunter dashboard running at ${url}`);
    console.log("Press Ctrl+C to stop.");
    if (opts.open !== false) openBrowser(url);
  });
}

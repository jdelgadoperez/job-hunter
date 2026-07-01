import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProfile } from "@app/profile/build-profile";
import { ensureDataDir, resolveDbPath } from "@app/runtime/paths";
import { getUpdateStatus } from "@app/runtime/update-check";
import type { UpdateStatus } from "@app/runtime/version";
import { Repository } from "@app/storage/repository";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import { createApp } from "./app";
import { classifyListenError } from "./listen-error";
import { ScanJobManager } from "./scan-job";
import { createScanRunner } from "./scan-runner";
import { ScoreJobManager } from "./score-job";
import { createScoreRun, previewScore } from "./score-runner";
import type { ScanRunner } from "./types";

// The built dashboard lives at <repo>/web/dist relative to this file (src/server/serve.ts).
const DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");

/**
 * Mount the built React app: static assets plus an SPA fallback to index.html. If the app hasn't
 * been built yet, serve a one-line hint instead of 404ing the root. The API routes are already
 * registered on `app`, so they win over these catch-alls.
 */
function mountDashboard(app: Hono): void {
  const indexPath = join(DIST_DIR, "index.html");
  if (!existsSync(indexPath)) {
    app.get("/", (c) =>
      c.html(
        "<h1>job-hunter</h1><p>The dashboard isn't built yet. Run <code>npm run build:web</code>, then reload.</p>",
      ),
    );
    return;
  }
  // serveStatic resolves `root` relative to cwd, so translate the absolute dist path.
  const root = relative(process.cwd(), DIST_DIR) || ".";
  app.use("/*", serveStatic({ root }));
  const indexHtml = readFileSync(indexPath, "utf8");
  app.get("/*", (c) => {
    if (c.req.path.startsWith("/api/")) return c.json({ error: "not found" }, 404);
    return c.html(indexHtml);
  });
}

export type ServeOptions = {
  /** Port to listen on. Defaults to 4317. */
  port?: number;
  /** Open the dashboard in the default browser on launch. Defaults to true. */
  open?: boolean;
  /** Auto-refresh interval in hours. 0 disables the scheduler. Defaults to 6. */
  refreshHours?: number;
};

const DEFAULT_PORT = 4317;
const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_REFRESH_HOURS = 6;
const UPDATE_CHECK_TTL_MS = 60 * 60 * 1000;

// The update check shells out to git + network, so cache it for an hour rather than per request.
let updateCache: { at: number; value: UpdateStatus } | null = null;
async function cachedUpdateStatus(): Promise<UpdateStatus> {
  if (updateCache && Date.now() - updateCache.at < UPDATE_CHECK_TTL_MS) return updateCache.value;
  const value = await getUpdateStatus();
  updateCache = { at: Date.now(), value };
  return value;
}

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
  const jobs = new ScanJobManager();
  const runScan = createScanRunner(repo);
  const scoreJobs = new ScoreJobManager();

  const app = createApp({
    repo,
    jobs,
    runScan,
    scoreJobs,
    createScoreRun: createScoreRun(repo),
    previewScore: previewScore(repo),
    buildProfileFromText: (resumeText) => {
      const dictionary = repo.getSkillDictionary();
      return buildProfile({
        resumeText,
        dictionary: dictionary.length > 0 ? dictionary : undefined,
      });
    },
    getUpdateStatus: cachedUpdateStatus,
  });

  mountDashboard(app);
  scheduleRefresh(jobs, runScan, opts.refreshHours ?? DEFAULT_REFRESH_HOURS);

  const port = opts.port ?? DEFAULT_PORT;
  // Bind to loopback only: this is an unauthenticated local-first dashboard, so it must not be
  // reachable from other machines on the network. (Omitting the host binds all interfaces.)
  const server = serve({ fetch: app.fetch, port, hostname: LOOPBACK_HOST }, (info) => {
    const url = `http://localhost:${info.port}`;
    console.log(`job-hunter dashboard running at ${url}`);
    console.log("Press Ctrl+C to stop.");
    if (opts.open !== false) openBrowser(url);
  });

  // A listen failure (e.g. the port is taken) surfaces on the server's "error" event. Log a
  // human-readable line and exit non-zero so the OS-level service restarts us — this is what makes
  // the background service self-heal once the conflict clears.
  server.on("error", (error: unknown) => {
    const verdict = classifyListenError(error, port);
    console.error(verdict.message);
    process.exitCode = 1;
    server.close();
  });
}

/**
 * Periodically kick off a background scan so matches stay warm without a manual trigger. The job
 * manager is single-flight, so a tick that lands while a scan is running is a no-op. A
 * non-positive interval disables the scheduler entirely.
 */
function scheduleRefresh(jobs: ScanJobManager, runScan: ScanRunner, hours: number): void {
  if (!Number.isFinite(hours) || hours <= 0) return;
  const intervalMs = hours * 60 * 60 * 1000;
  const timer = setInterval(() => {
    if (!jobs.isRunning()) jobs.start(runScan);
  }, intervalMs);
  // Don't let the scheduler alone keep the process alive (the listener already does).
  timer.unref();
  console.log(`Auto-refresh every ${hours}h (use --refresh-hours 0 to disable).`);
}

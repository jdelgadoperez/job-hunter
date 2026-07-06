/**
 * Developer convenience: run the API server and the Vite dev server together.
 *
 *   npm run dev
 *
 * Starts `job-hunter serve` (Hono API on :48373, no auto-open, no scheduled scans) alongside the
 * Vite dev server (hot-reload UI on :5173, which proxies /api to :48373). Use the :5173 URL. Either
 * process exiting tears down the other; Ctrl+C stops both.
 */
import { type ChildProcess, spawn } from "node:child_process";

const children: ChildProcess[] = [];
let shuttingDown = false;

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  process.exit(code);
}

function run(label: string, command: string): void {
  // `shell: true` resolves npm/.bin scripts cross-platform; stdio inherited so logs stream through.
  const child = spawn(command, { stdio: "inherit", shell: true });
  children.push(child);
  child.on("exit", (code) => {
    console.log(`\n[${label}] exited (${code ?? 0}) — stopping the other process.`);
    shutdown(code ?? 0);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("Starting API (:48373) + web dev server (:5173)… open http://localhost:5173\n");
run("api", "npm run serve -- --no-open --refresh-hours 0");
run("web", "npm run dev:web");

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The lifecycle verbs the background-service scripts expose. */
export const SERVICE_ACTIONS = [
  "install",
  "uninstall",
  "start",
  "stop",
  "restart",
  "status",
] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

export function isServiceAction(value: string): value is ServiceAction {
  return (SERVICE_ACTIONS as readonly string[]).includes(value);
}

/** How to invoke one platform's service script: the program to run and the arguments to pass it. */
export type ServiceInvocation = { command: string; args: string[] };

/**
 * Resolve the shell command that runs the background-service script for `action` on `platform`,
 * given the repo root. Pure (no spawning) so dispatch is unit-tested without touching the OS.
 *
 * - Windows (`win32`) runs the PowerShell `.ps1` via `powershell` with an unrestricted execution
 *   policy for this one invocation (the scripts aren't signed) — mirroring how a user would run
 *   `./service-install.ps1` from a PowerShell prompt.
 * - Everything else runs the Bash `.sh` directly (they carry a shebang and are executable).
 */
export function resolveServiceInvocation(
  action: ServiceAction,
  platform: NodeJS.Platform,
  repoRoot: string,
): ServiceInvocation {
  if (platform === "win32") {
    const script = resolve(repoRoot, `service-${action}.ps1`);
    return {
      command: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
    };
  }
  const script = resolve(repoRoot, `service-${action}.sh`);
  return { command: script, args: [] };
}

/** The repo root — this file lives at <repo>/src/cli/service.ts. */
function repoRoot(): string {
  return resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
}

/**
 * Run the background-service script for `action`, inheriting stdio so the user sees the script's
 * own output, and resolve with its exit code. Never throws for a non-zero exit — the caller maps
 * the code onto `process.exitCode`, consistent with the rest of the CLI's degrade-don't-crash style.
 */
export function runServiceCommand(
  action: ServiceAction,
  platform: NodeJS.Platform = process.platform,
  root: string = repoRoot(),
): Promise<number> {
  const { command, args } = resolveServiceInvocation(action, platform, root);
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", (error) => {
      console.error(`Could not run the ${action} script: ${error.message}`);
      resolvePromise(1);
    });
    child.on("close", (code) => resolvePromise(code ?? 0));
  });
}

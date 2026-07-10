import { style } from "./style";

/** A diagnostics sink: progress/warnings (`diag`) and debug lines (`debug`) — all to stderr. */
export type Diagnostics = {
  diag: (message: string) => void;
  debug: (namespace: string, message: string) => void;
  isDebugEnabled: boolean;
};

/** True when the `DEBUG` env var opts this app in: `job-hunter`, `job-hunter:*`, or `*`. */
export function debugEnabledFromEnv(env: NodeJS.ProcessEnv): boolean {
  const value = env.DEBUG?.trim();
  if (!value) return false;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .some((entry) => entry === "*" || entry === "job-hunter" || entry.startsWith("job-hunter:"));
}

/**
 * Build the diagnostics sink. `diag` always writes (progress/warnings belong on stderr in every
 * mode). `debug` writes only when `--verbose` or a matching `DEBUG` env var is set. `write` is
 * injectable so tests capture output without touching the real stream; it defaults to stderr.
 */
export function createDiagnostics(
  opts: { verbose: boolean; json: boolean },
  write: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
): Diagnostics {
  const isDebugEnabled = opts.verbose || debugEnabledFromEnv(process.env);
  return {
    diag: (message) => write(`${message}\n`),
    debug: (namespace, message) => {
      if (isDebugEnabled) write(`${style.dim(`[${namespace}]`)} ${message}\n`);
    },
    isDebugEnabled,
  };
}

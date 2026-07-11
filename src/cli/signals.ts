/** The subset of `process` (and a test `EventEmitter`) that signal registration needs. */
export type SignalTarget = {
  on(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown;
};

const SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * Register a one-shot shutdown handler for SIGINT + SIGTERM on `target` (defaults to `process`).
 * The handler fires at most once — a second Ctrl+C while shutting down is ignored. Returns a
 * `dispose()` that removes both listeners, so a one-shot command can deregister on normal completion
 * and never leak a handler into a later command sharing the same process.
 */
export function onShutdown(
  handler: (signal: "SIGINT" | "SIGTERM") => void,
  target: SignalTarget = process,
): () => void {
  let firing = false;
  const listeners = SIGNALS.map((signal) => {
    const listener = () => {
      if (firing) return;
      firing = true;
      handler(signal);
    };
    target.on(signal, listener);
    return { signal, listener } as const;
  });

  return () => {
    for (const { signal, listener } of listeners) target.off(signal, listener);
  };
}

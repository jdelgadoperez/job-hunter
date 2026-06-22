/**
 * Reject if `promise` doesn't settle within `ms`. A wall-clock guard for integration-bound work
 * (launching a browser, loading a page) whose own internal timeouts can't be trusted to bound the
 * total — so a hang becomes a surfaced error instead of an unbounded wait. The timer is `unref`'d
 * so it never keeps the process alive on its own.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

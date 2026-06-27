import { errorMessage } from "@app/net/error-message";

/**
 * Returns true when the error signals that the provider has hit a hard usage limit or rate limit —
 * the signal to stop making new LLM calls immediately rather than hammering a dead quota.
 *
 * Deliberately excludes generic authentication errors (401 / "authentication" keyword): those are
 * config problems that should fail loudly, not mid-run aborts.
 */
export function isUsageLimitError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("usage limit") ||
    message.includes("usage limits") ||
    message.includes("rate limit")
  );
}

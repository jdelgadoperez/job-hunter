/**
 * Prompt-cache telemetry for the Anthropic clients.
 *
 * Both `score` LLM steps (batch triage + deep score) send a stable, cached system prefix
 * (`cache_control: { type: "ephemeral" }`) followed by a volatile user turn. Whether that cache
 * actually engages is invisible without reading the per-call `usage` the API returns — and it only
 * engages when the cached prefix meets the model's minimum cacheable size (Sonnet 4.6 = 2048
 * tokens; the Opus 4.x family + Haiku 4.5 = 4096), otherwise the marker is silently a no-op. This
 * module normalizes those usage fields and accumulates them so the CLI can report a cache hit-rate
 * after a run — turning "is caching working?" into a measured number.
 */

/** Cache-relevant token usage from a single Anthropic Messages call. */
export type LlmUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Uncached input tokens served from the prompt cache on a hit (~0.1x input cost). */
  cacheReadTokens: number;
  /** Input tokens written to the prompt cache on a miss (~1.25x input cost). */
  cacheCreationTokens: number;
};

/** The nullable wire shape of the SDK's `response.usage`; richer objects assign to it structurally. */
export type RawUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/** Normalize an SDK `usage` object (nullable wire fields) into a dense `LlmUsage`. */
export function toLlmUsage(raw: RawUsage | null | undefined): LlmUsage {
  return {
    inputTokens: raw?.input_tokens ?? 0,
    outputTokens: raw?.output_tokens ?? 0,
    cacheReadTokens: raw?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: raw?.cache_creation_input_tokens ?? 0,
  };
}

/** Running total across many calls; the `score` command sums triage + deep-score usage here. */
export class UsageAccumulator {
  private readonly total: LlmUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  private calls = 0;

  add(usage: LlmUsage): void {
    this.total.inputTokens += usage.inputTokens;
    this.total.outputTokens += usage.outputTokens;
    this.total.cacheReadTokens += usage.cacheReadTokens;
    this.total.cacheCreationTokens += usage.cacheCreationTokens;
    this.calls += 1;
  }

  get callCount(): number {
    return this.calls;
  }

  get totals(): LlmUsage {
    return { ...this.total };
  }

  /**
   * Share of *cacheable* input tokens that were served from cache: reads / (reads + writes).
   * 0 when nothing cacheable was sent (e.g. the prefix never crossed the minimum cacheable size).
   */
  cacheHitRate(): number {
    const cacheable = this.total.cacheReadTokens + this.total.cacheCreationTokens;
    return cacheable === 0 ? 0 : this.total.cacheReadTokens / cacheable;
  }
}

/**
 * One-line human summary of accumulated usage for the CLI. Returns `null` when no LLM calls were
 * made (dry run, no eligible postings) so the caller can skip printing. When caching never engaged
 * it says so explicitly and points at the likely cause, since a silent no-op is the common trap.
 */
export function formatUsageSummary(acc: UsageAccumulator): string | null {
  if (acc.callCount === 0) return null;
  const t = acc.totals;
  const cacheable = t.cacheReadTokens + t.cacheCreationTokens;
  const header = `LLM usage over ${acc.callCount} call(s): ${t.inputTokens} input + ${t.outputTokens} output tokens`;
  if (cacheable === 0) {
    const reason =
      "  prompt caching did not engage — the cached system prefix is below the model's minimum cacheable size (Sonnet 4.6 = 2048 tokens; Opus 4.x / Haiku 4.5 = 4096), so the cache_control marker was a no-op. See docs/prompt-caching.md.";
    return `${header}\n${reason}`;
  }
  const pct = Math.round(acc.cacheHitRate() * 100);
  const detail = `  prompt cache: ${t.cacheReadTokens} read + ${t.cacheCreationTokens} written (${pct}% of cacheable input served from cache)`;
  return `${header}\n${detail}`;
}

import { describe, expect, it } from "vitest";
import { UsageAccumulator, formatUsageSummary, toLlmUsage } from "./llm-usage";

describe("toLlmUsage", () => {
  it("maps the SDK wire fields into a dense LlmUsage", () => {
    expect(
      toLlmUsage({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 8,
        cache_creation_input_tokens: 2,
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 8, cacheCreationTokens: 2 });
  });

  it("coalesces null/undefined fields to zero", () => {
    expect(toLlmUsage({ input_tokens: 3, cache_read_input_tokens: null })).toEqual({
      inputTokens: 3,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(toLlmUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});

describe("UsageAccumulator", () => {
  it("sums usage across calls and counts them", () => {
    const acc = new UsageAccumulator();
    acc.add({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 100 });
    acc.add({ inputTokens: 100, outputTokens: 12, cacheReadTokens: 100, cacheCreationTokens: 0 });

    expect(acc.callCount).toBe(2);
    expect(acc.totals).toEqual({
      inputTokens: 200,
      outputTokens: 22,
      cacheReadTokens: 100,
      cacheCreationTokens: 100,
    });
  });

  it("computes the cache hit rate as reads / (reads + writes)", () => {
    const acc = new UsageAccumulator();
    acc.add({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 75, cacheCreationTokens: 25 });
    expect(acc.cacheHitRate()).toBeCloseTo(0.75);
  });

  it("reports a zero hit rate when nothing cacheable was sent", () => {
    const acc = new UsageAccumulator();
    acc.add({ inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(acc.cacheHitRate()).toBe(0);
  });
});

describe("formatUsageSummary", () => {
  it("returns null when no calls were made", () => {
    expect(formatUsageSummary(new UsageAccumulator())).toBeNull();
  });

  it("flags when caching never engaged", () => {
    const acc = new UsageAccumulator();
    acc.add({ inputTokens: 400, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 });
    const summary = formatUsageSummary(acc);
    expect(summary).toContain("prompt caching did not engage");
    expect(summary).toContain("minimum");
  });

  it("reports the hit rate when caching engaged", () => {
    const acc = new UsageAccumulator();
    acc.add({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 2048 });
    acc.add({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 2048, cacheCreationTokens: 0 });
    const summary = formatUsageSummary(acc);
    expect(summary).toContain("prompt cache:");
    expect(summary).toContain("50% of cacheable input served from cache");
  });
});

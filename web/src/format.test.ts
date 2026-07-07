import { describe, expect, it } from "vitest";
import { formatAbsoluteTime, formatCount, formatRelativeTime } from "./format";

/** An ISO timestamp `secondsAgo` seconds before now, so tests read relative to the current clock
 *  rather than a hardcoded date. */
function isoSecondsAgo(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

describe("formatCount", () => {
  it("leaves values below a thousand unchanged", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(42)).toBe("42");
    expect(formatCount(999)).toBe("999");
  });

  it("inserts thousands separators", () => {
    expect(formatCount(1000)).toBe("1,000");
    expect(formatCount(12345)).toBe("12,345");
    expect(formatCount(1000000)).toBe("1,000,000");
  });
});

describe("formatRelativeTime", () => {
  it("reads under a minute as 'just now'", () => {
    expect(formatRelativeTime(isoSecondsAgo(5))).toBe("just now");
    expect(formatRelativeTime(isoSecondsAgo(59))).toBe("just now");
  });

  it("picks the largest sensible unit", () => {
    expect(formatRelativeTime(isoSecondsAgo(120))).toBe("2 minutes ago");
    expect(formatRelativeTime(isoSecondsAgo(2 * 3600))).toBe("2 hours ago");
    expect(formatRelativeTime(isoSecondsAgo(3 * 86400))).toBe("3 days ago");
  });

  it("returns null for missing or unparseable input", () => {
    expect(formatRelativeTime(null)).toBeNull();
    expect(formatRelativeTime(undefined)).toBeNull();
    expect(formatRelativeTime("not a date")).toBeNull();
  });
});

describe("formatAbsoluteTime", () => {
  it("returns a non-empty string for a valid timestamp", () => {
    expect(formatAbsoluteTime(isoSecondsAgo(0))).toBeTruthy();
  });

  it("returns null for missing or unparseable input", () => {
    expect(formatAbsoluteTime(null)).toBeNull();
    expect(formatAbsoluteTime("nonsense")).toBeNull();
  });
});

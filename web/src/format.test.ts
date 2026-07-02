import { describe, expect, it } from "vitest";
import { formatCount } from "./format";

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

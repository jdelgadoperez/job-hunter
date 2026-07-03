import { describe, expect, it } from "vitest";
import { detectHomeCountry } from "./detect-home-country";

describe("detectHomeCountry", () => {
  it("returns the parsed country when none is set", () => {
    expect(detectHomeCountry("123 Main St, Austin, Texas 78701", undefined)).toBe("US");
  });

  it("returns undefined (no change) when a country is already set", () => {
    expect(detectHomeCountry("123 Main St, Austin, Texas", "UK")).toBeUndefined();
  });

  it("returns undefined when the resume has no parseable country", () => {
    expect(detectHomeCountry("Software engineer, remote", undefined)).toBeUndefined();
  });
});

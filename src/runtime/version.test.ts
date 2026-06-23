import { describe, expect, it } from "vitest";
import { getVersion, toUpdateStatus } from "./version";

describe("getVersion", () => {
  it("reads a semver-ish version from package.json", () => {
    expect(getVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("toUpdateStatus", () => {
  it("flags an update only when behind by a positive count", () => {
    expect(toUpdateStatus("0.1.0", 3)).toEqual({
      version: "0.1.0",
      behind: 3,
      updateAvailable: true,
    });
    expect(toUpdateStatus("0.1.0", 0)).toEqual({
      version: "0.1.0",
      behind: 0,
      updateAvailable: false,
    });
  });

  it("treats an unknown (null) behind count as no update", () => {
    expect(toUpdateStatus("0.1.0", null)).toEqual({
      version: "0.1.0",
      behind: null,
      updateAvailable: false,
    });
  });
});

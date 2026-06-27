import { describe, expect, it } from "vitest";
import { isRemote } from "./remote-filter";

describe("isRemote", () => {
  const remoteStrings = [
    "Remote",
    "REMOTE",
    "Remote - US",
    "Remote - Worldwide",
    "Remote (United States)",
    "Remote in Canada in EST timezone",
    "Anywhere",
    "Distributed team",
    "Work from home",
    "WFH",
  ];
  for (const location of remoteStrings) {
    it(`treats "${location}" as remote`, () => {
      expect(isRemote(location)).toBe(true);
    });
  }

  const onsiteStrings = ["London, UK", "New York, NY", "San Francisco, CA"];
  for (const location of onsiteStrings) {
    it(`treats "${location}" as not remote`, () => {
      expect(isRemote(location)).toBe(false);
    });
  }

  it("keeps postings with an unknown location (undefined)", () => {
    expect(isRemote(undefined)).toBe(true);
  });

  it("keeps postings with an empty location string", () => {
    expect(isRemote("")).toBe(true);
    expect(isRemote("   ")).toBe(true);
  });
});

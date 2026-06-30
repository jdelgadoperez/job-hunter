import { describe, expect, it } from "vitest";
import { isRemote, resolvePostingRemote } from "./remote-filter";

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

describe("resolvePostingRemote", () => {
  it("trusts an explicit remote=true even when the location reads on-site", () => {
    expect(resolvePostingRemote({ remote: true, location: "New York, NY" })).toBe(true);
  });

  it("trusts an explicit remote=false even when the location reads remote", () => {
    expect(resolvePostingRemote({ remote: false, location: "Remote - US" })).toBe(false);
  });

  it("falls back to the location regex when remote is undefined", () => {
    expect(resolvePostingRemote({ location: "Remote - US" })).toBe(true);
    expect(resolvePostingRemote({ location: "New York, NY" })).toBe(false);
  });

  it("treats a blank/unknown location as remote when there is no flag", () => {
    expect(resolvePostingRemote({})).toBe(true);
  });
});

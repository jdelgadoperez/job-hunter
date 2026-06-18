import { describe, expect, it } from "vitest";
import { resolveAts } from "./resolve-ats";

describe("resolveAts", () => {
  it("detects Greenhouse on both board hosts", () => {
    for (const url of [
      "https://boards.greenhouse.io/acme",
      "https://job-boards.greenhouse.io/acme",
    ]) {
      const resolved = resolveAts(url);
      expect(resolved?.connector.source).toBe("greenhouse");
      expect(resolved?.boardToken).toBe("acme");
    }
  });

  it("detects Lever", () => {
    const resolved = resolveAts("https://jobs.lever.co/acme");
    expect(resolved?.connector.source).toBe("lever");
    expect(resolved?.boardToken).toBe("acme");
  });

  it("detects Ashby", () => {
    const resolved = resolveAts("https://jobs.ashbyhq.com/acme");
    expect(resolved?.connector.source).toBe("ashby");
    expect(resolved?.boardToken).toBe("acme");
  });

  it("returns null for an unknown careers host", () => {
    expect(resolveAts("https://acme.com/careers")).toBeNull();
  });

  it("returns null for a non-url", () => {
    expect(resolveAts("not a url")).toBeNull();
  });
});

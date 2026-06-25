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

  it("detects Rippling, taking the board slug as the token", () => {
    const resolved = resolveAts("https://ats.rippling.com/acme/jobs");
    expect(resolved?.connector.source).toBe("rippling");
    expect(resolved?.boardToken).toBe("acme");
  });

  it("detects Workday on any tenant subdomain, passing the full URL as the token", () => {
    const url = "https://genesys.wd1.myworkdayjobs.com/en-US/Genesys";
    const resolved = resolveAts(url);
    expect(resolved?.connector.source).toBe("workday");
    expect(resolved?.boardToken).toBe(url);
  });

  it("returns null for an unknown careers host", () => {
    expect(resolveAts("https://acme.com/careers")).toBeNull();
  });

  it("returns null for a non-url", () => {
    expect(resolveAts("not a url")).toBeNull();
  });
});

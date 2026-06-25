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

  it("detects Recruitee, taking the subdomain as the token", () => {
    const resolved = resolveAts("https://acme.recruitee.com/");
    expect(resolved?.connector.source).toBe("recruitee");
    expect(resolved?.boardToken).toBe("acme");
  });

  it("does not treat the Recruitee apex or reserved subdomains as a board", () => {
    expect(resolveAts("https://recruitee.com/")).toBeNull();
    expect(resolveAts("https://www.recruitee.com/")).toBeNull();
    expect(resolveAts("https://support.recruitee.com/en/")).toBeNull();
  });

  it("detects SmartRecruiters, taking the company id as the token", () => {
    const resolved = resolveAts("https://careers.smartrecruiters.com/Freshworks");
    expect(resolved?.connector.source).toBe("smartrecruiters");
    expect(resolved?.boardToken).toBe("Freshworks");
  });

  it("detects BambooHR, taking the subdomain as the token", () => {
    const resolved = resolveAts("https://acme.bamboohr.com/careers");
    expect(resolved?.connector.source).toBe("bamboohr");
    expect(resolved?.boardToken).toBe("acme");
  });

  it("detects Breezy, taking the subdomain as the token", () => {
    const resolved = resolveAts("https://acme.breezy.hr/");
    expect(resolved?.connector.source).toBe("breezy");
    expect(resolved?.boardToken).toBe("acme");
  });

  it("does not treat a subdomain-ATS apex or reserved subdomain as a board", () => {
    expect(resolveAts("https://breezy.hr/")).toBeNull();
    expect(resolveAts("https://www.breezy.hr/attract")).toBeNull();
    expect(resolveAts("https://bamboohr.com/")).toBeNull();
  });

  it("detects Workday on any tenant subdomain, passing the full URL as the token", () => {
    const url = "https://genesys.wd1.myworkdayjobs.com/en-US/Genesys";
    const resolved = resolveAts(url);
    expect(resolved?.connector.source).toBe("workday");
    expect(resolved?.boardToken).toBe(url);
  });

  it("detects UKG/UltiPro, passing the full URL as the token", () => {
    const url = "https://recruiting.ultipro.com/ACME1000/JobBoard/abc-123/?q=&o=postedDateDesc";
    const resolved = resolveAts(url);
    expect(resolved?.connector.source).toBe("ukg");
    expect(resolved?.boardToken).toBe(url);
  });

  it("returns null for an unknown careers host", () => {
    expect(resolveAts("https://acme.com/careers")).toBeNull();
  });

  it("returns null for a non-url", () => {
    expect(resolveAts("not a url")).toBeNull();
  });
});

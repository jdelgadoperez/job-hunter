import type { JobPosting, MatchResult, SkillProfile } from "@app/domain/types";
import { describe, expect, it } from "vitest";
import { Repository } from "./repository";

function newRepo(): Repository {
  return new Repository(":memory:");
}

const profile: SkillProfile = {
  skills: ["typescript"],
  roleKeywords: ["frontend engineer"],
  categories: ["Engineering"],
  yearsExperience: 15,
};

const posting: JobPosting = {
  id: "abc",
  company: "Acme",
  title: "Engineer",
  url: "https://example.com/abc",
  source: "greenhouse",
  description: "TypeScript role",
  fetchedAt: new Date("2026-06-17T00:00:00Z"),
};

describe("Repository", () => {
  it("round-trips a setting", () => {
    const repo = newRepo();
    repo.setSetting("apiKey", "secret-value");
    expect(repo.getSetting("apiKey")).toBe("secret-value");
    repo.close();
  });

  it("returns the latest profile and scored postings ordered by score", () => {
    const repo = newRepo();
    expect(repo.getLatestProfile()).toBeUndefined();
    repo.saveProfile(profile);
    repo.saveProfile({ ...profile, skills: ["typescript", "go"] });
    expect(repo.getLatestProfile()?.skills).toEqual(["typescript", "go"]);

    repo.savePosting(posting);
    repo.savePosting({ ...posting, id: "def", title: "Other" });
    repo.saveMatchResult("abc", { score: 90, matchedSkills: ["typescript"], missingSkills: [] });
    repo.saveMatchResult("def", { score: 40, matchedSkills: [], missingSkills: ["go"] });

    const all = repo.listScoredPostings();
    expect(all.map((s) => s.result.score)).toEqual([90, 40]);
    expect(all[0]?.posting.fetchedAt).toBeInstanceOf(Date);
    expect(repo.listScoredPostings(50).map((s) => s.posting.id)).toEqual(["abc"]);
    repo.close();
  });

  it("adds, lists, and removes tracked companies without duplicating", () => {
    const repo = newRepo();
    repo.addTrackedCompany("https://acme.com/careers", "Acme");
    repo.addTrackedCompany("https://globex.com/jobs");
    // Re-adding the same URL updates the name rather than duplicating.
    repo.addTrackedCompany("https://acme.com/careers", "Acme Inc");

    const tracked = repo.listTrackedCompanies();
    expect(tracked).toEqual([
      { careersUrl: "https://acme.com/careers", name: "Acme Inc" },
      { careersUrl: "https://globex.com/jobs" },
    ]);

    expect(repo.removeTrackedCompany("https://acme.com/careers")).toBe(true);
    expect(repo.removeTrackedCompany("https://acme.com/careers")).toBe(false);
    expect(repo.listTrackedCompanies()).toEqual([{ careersUrl: "https://globex.com/jobs" }]);
    repo.close();
  });

  it("returns undefined for a missing setting", () => {
    const repo = newRepo();
    expect(repo.getSetting("missing")).toBeUndefined();
    repo.close();
  });

  it("overwrites a setting on repeated set", () => {
    const repo = newRepo();
    repo.setSetting("apiKey", "first");
    repo.setSetting("apiKey", "second");
    expect(repo.getSetting("apiKey")).toBe("second");
    repo.close();
  });

  it("saves a profile and returns a positive row id", () => {
    const repo = newRepo();
    const id = repo.saveProfile(profile);
    expect(id).toBeGreaterThan(0);
    repo.close();
  });

  it("saves a posting and an idempotent user action without throwing", () => {
    const repo = newRepo();
    repo.savePosting(posting);
    repo.setUserAction(posting.id, "saved");
    repo.setUserAction(posting.id, "dismissed");
    repo.close();
  });

  it("saves a match result for a stored posting", () => {
    const repo = newRepo();
    repo.savePosting(posting);
    const result: MatchResult = {
      score: 50,
      matchedSkills: ["typescript"],
      missingSkills: ["go"],
    };
    expect(() => repo.saveMatchResult(posting.id, result)).not.toThrow();
    repo.close();
  });
});

function postingWith(id: string): JobPosting {
  return { ...posting, id, url: `https://example.com/${id}` };
}

describe("incremental scans — directory diff", () => {
  it("treats the first scan as a baseline (no diff), then reports new/removed", () => {
    const repo = newRepo();

    const s1 = repo.startScan();
    const baseline = repo.recordDirectory(s1, [
      { careersUrl: "https://a.com", name: "A" },
      { careersUrl: "https://b.com", name: "B" },
    ]);
    expect(baseline).toEqual({ newCompanies: [], removedCompanies: [] });

    const s2 = repo.startScan();
    const diff = repo.recordDirectory(s2, [
      { careersUrl: "https://a.com", name: "A" },
      { careersUrl: "https://c.com", name: "C" },
    ]);
    expect(diff.newCompanies).toEqual([{ careersUrl: "https://c.com", name: "C" }]);
    expect(diff.removedCompanies).toEqual([{ careersUrl: "https://b.com", name: "B" }]);

    repo.finishScan(s2, {
      postingsSeen: 0,
      companiesSeen: 2,
      newCompanies: diff.newCompanies,
      removedCompanies: diff.removedCompanies,
    });
    const latest = repo.getLatestScan();
    expect(latest?.id).toBe(s2);
    expect(latest?.removedCompanies).toEqual([{ careersUrl: "https://b.com", name: "B" }]);
    repo.close();
  });

  it("does not re-report a company removed in an earlier scan", () => {
    const repo = newRepo();
    repo.recordDirectory(repo.startScan(), [{ careersUrl: "https://b.com" }]); // baseline
    const drop = repo.recordDirectory(repo.startScan(), []); // b removed here
    expect(drop.removedCompanies).toEqual([{ careersUrl: "https://b.com" }]);
    const after = repo.recordDirectory(repo.startScan(), []); // already gone — silent
    expect(after.removedCompanies).toEqual([]);
    repo.close();
  });
});

describe("incremental scans — posting expiry", () => {
  function seedScored(repo: Repository, id: string, scanId: number): void {
    repo.savePosting(postingWith(id), scanId);
    repo.saveMatchResult(id, { score: 80, matchedSkills: [], missingSkills: [] });
  }

  it("expires a posting after it misses two consecutive scans, and revives it on return", () => {
    const repo = newRepo();
    const s1 = repo.startScan();
    seedScored(repo, "p1", s1);

    // One missed scan: still listed.
    expect(repo.expireStalePostings(repo.startScan())).toBe(0);
    expect(repo.listScoredPostings(0)).toHaveLength(1);

    // Second consecutive miss: expired and dropped from the default list.
    const expired = repo.expireStalePostings(repo.startScan());
    expect(expired).toBe(1);
    expect(repo.listScoredPostings(0)).toHaveLength(0);
    expect(repo.listScoredPostings(0, { includeExpired: true })).toHaveLength(1);

    // Seen again in a later scan: revived.
    seedScored(repo, "p1", repo.startScan());
    expect(repo.listScoredPostings(0)).toHaveLength(1);
    repo.close();
  });

  it("never expires legacy postings saved without a scan id", () => {
    const repo = newRepo();
    repo.savePosting(postingWith("legacy")); // no scanId
    repo.saveMatchResult("legacy", { score: 90, matchedSkills: [], missingSkills: [] });
    expect(repo.expireStalePostings(99)).toBe(0);
    expect(repo.listScoredPostings(0)).toHaveLength(1);
    repo.close();
  });
});

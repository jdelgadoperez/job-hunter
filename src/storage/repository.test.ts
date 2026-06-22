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

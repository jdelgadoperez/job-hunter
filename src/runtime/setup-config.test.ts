import { AIRTABLE_SHARE_SETTING } from "@app/discovery/sources/airtable";
import { Repository } from "@app/storage/repository";
import { describe, expect, it } from "vitest";
import { DEFAULT_SHARE_URL, applyConfig, seedSkillDictionary } from "./setup-config";

function newRepo(): Repository {
  return new Repository(":memory:");
}

describe("seedSkillDictionary", () => {
  it("seeds skills and returns the dictionary size", () => {
    const repo = newRepo();
    const count = seedSkillDictionary(repo, [
      { name: "typescript", category: "engineering" },
      { name: "react", category: "engineering" },
    ]);
    expect(count).toBe(2);
    expect(repo.getSkillDictionary()).toContain("typescript");
    repo.close();
  });
});

describe("applyConfig", () => {
  it("persists key, share URL, and a profile when all answers are given", () => {
    const repo = newRepo();
    seedSkillDictionary(repo, [{ name: "typescript", category: "engineering" }]);
    const result = applyConfig(repo, {
      apiKey: "  sk-123  ",
      shareUrl: "https://airtable.com/appX/shrX/tblX",
      resumeText: "I have built systems with TypeScript.",
    });

    expect(result.savedApiKey).toBe(true);
    expect(result.shareUrl).toBe("https://airtable.com/appX/shrX/tblX");
    expect(result.profileSkills).not.toBeNull();
    expect(repo.getSetting("anthropicApiKey")).toBe("sk-123");
    expect(repo.getSetting(AIRTABLE_SHARE_SETTING)).toBe("https://airtable.com/appX/shrX/tblX");
    expect(repo.getLatestProfile()?.skills).toContain("typescript");
    repo.close();
  });

  it("defaults the share URL and skips key/profile when omitted", () => {
    const repo = newRepo();
    const result = applyConfig(repo, {});
    expect(result.savedApiKey).toBe(false);
    expect(result.shareUrl).toBe(DEFAULT_SHARE_URL);
    expect(result.profileSkills).toBeNull();
    expect(repo.getSetting("anthropicApiKey")).toBeUndefined();
    expect(repo.getSetting(AIRTABLE_SHARE_SETTING)).toBe(DEFAULT_SHARE_URL);
    expect(repo.getLatestProfile()).toBeUndefined();
    repo.close();
  });
});

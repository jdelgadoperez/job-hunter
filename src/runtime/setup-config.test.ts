import { Repository } from "@app/storage/repository";
import { describe, expect, it } from "vitest";
import { applyConfig, seedSkillDictionary } from "./setup-config";

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
  it("persists the key and builds a profile when both are given", () => {
    const repo = newRepo();
    seedSkillDictionary(repo, [{ name: "typescript", category: "engineering" }]);
    const result = applyConfig(repo, {
      apiKey: "  sk-123  ",
      resumeText: "I have built systems with TypeScript.",
    });

    expect(result.savedApiKey).toBe(true);
    expect(result.profileSkills).not.toBeNull();
    expect(repo.getSetting("anthropicApiKey")).toBe("sk-123");
    expect(repo.getLatestProfile()?.skills).toContain("typescript");
    repo.close();
  });

  it("skips key and profile when omitted", () => {
    const repo = newRepo();
    const result = applyConfig(repo, {});
    expect(result.savedApiKey).toBe(false);
    expect(result.profileSkills).toBeNull();
    expect(repo.getSetting("anthropicApiKey")).toBeUndefined();
    expect(repo.getLatestProfile()).toBeUndefined();
    repo.close();
  });
});

import skillSeed from "@app/domain/data/skill-seed.json";
import { describe, expect, it } from "vitest";
import { Repository } from "./repository";

function newRepo(): Repository {
  return new Repository(":memory:");
}

describe("Repository skills dictionary", () => {
  it("returns an empty dictionary before seeding", () => {
    const repo = newRepo();
    expect(repo.getSkillDictionary()).toEqual([]);
    repo.close();
  });

  it("round-trips the seeded skill names", () => {
    const repo = newRepo();
    repo.seedSkills(skillSeed.skills);
    const dictionary = repo.getSkillDictionary();
    expect(dictionary).toContain("adobe photoshop");
    expect(dictionary).toContain("seo");
    expect(dictionary).toHaveLength(skillSeed.skills.length);
    repo.close();
  });

  it("is idempotent across re-seeding", () => {
    const repo = newRepo();
    repo.seedSkills(skillSeed.skills);
    repo.seedSkills(skillSeed.skills);
    expect(repo.getSkillDictionary()).toHaveLength(skillSeed.skills.length);
    repo.close();
  });
});

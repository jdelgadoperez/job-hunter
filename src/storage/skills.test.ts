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

  it("normalizes skill names added directly so casing variants don't duplicate", () => {
    const repo = newRepo();
    repo.addSkill("TypeScript", "engineering");
    // Same skill, different casing — must update the existing row, not add one.
    repo.addSkill("typescript", "language");

    expect(repo.listSkills()).toEqual([{ name: "typescript", category: "language" }]);

    // Removal must match on the same normalized key regardless of the casing used to add it.
    expect(repo.removeSkill("TYPESCRIPT")).toBe(true);
    expect(repo.listSkills()).toEqual([]);
    repo.close();
  });

  it("normalizes seeded skill names so casing variants don't duplicate", () => {
    const repo = newRepo();
    repo.seedSkills([
      { name: "TypeScript", category: "engineering" },
      { name: "typescript", category: "engineering" },
    ]);
    expect(repo.getSkillDictionary()).toEqual(["typescript"]);
    repo.close();
  });
});

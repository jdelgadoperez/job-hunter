import { describe, expect, it } from "vitest";
import { extractSkills } from "../domain/extract-skills.js";
import { normalizeSkill } from "../domain/normalize.js";
import { buildProfile } from "./build-profile.js";

describe("buildProfile", () => {
  it("merges resume-extracted skills with manual skills, normalized and deduped", () => {
    const resumeText = "Engineer with TypeScript and React.";
    const profile = buildProfile({
      resumeText,
      manualSkills: ["AWS", "typescript"],
    });

    const fromResume = extractSkills(resumeText);
    for (const skill of fromResume) {
      expect(profile.skills).toContain(skill);
    }
    expect(profile.skills).toContain(normalizeSkill("AWS"));

    const tsCount = profile.skills.filter((s) => s === normalizeSkill("TypeScript")).length;
    expect(tsCount).toBe(1);
  });

  it("passes through role keywords and categories", () => {
    const profile = buildProfile({
      roleKeywords: ["Frontend Engineer"],
      categories: ["Engineering", "Remote"],
      yearsExperience: 15,
    });
    expect(profile.roleKeywords).toContain("frontend engineer");
    expect(profile.categories).toEqual(["Engineering", "Remote"]);
    expect(profile.yearsExperience).toBe(15);
  });

  it("produces an empty skill list when given no input", () => {
    const profile = buildProfile({});
    expect(profile.skills).toEqual([]);
  });
});

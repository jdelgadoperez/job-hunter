import { describe, expect, it } from "vitest";
import skillSeed from "./data/skill-seed.json";
import { extractSkills } from "./extract-skills";
import { DEFAULT_SKILL_DICTIONARY, resolveSkillDictionary } from "./skill-dictionary";

describe("resolveSkillDictionary", () => {
  it("falls back to the default when no repo is given", () => {
    expect(resolveSkillDictionary()).toEqual(DEFAULT_SKILL_DICTIONARY);
  });

  it("falls back to the default when the repo is unseeded", () => {
    expect(resolveSkillDictionary({ getSkillDictionary: () => [] })).toEqual(
      DEFAULT_SKILL_DICTIONARY,
    );
  });

  it("prefers the repo's seeded dictionary when present", () => {
    const seeded = ["adobe photoshop", "seo"];
    expect(resolveSkillDictionary({ getSkillDictionary: () => seeded })).toEqual(seeded);
  });
});

describe("expanded skill taxonomy coverage", () => {
  const bio = "Marketing designer skilled in Adobe Photoshop and SEO with finance reporting.";

  it("misses non-engineering skills with the default dictionary", () => {
    expect(extractSkills(bio, DEFAULT_SKILL_DICTIONARY)).toEqual([]);
  });

  it("finds non-engineering skills via the seeded dictionary", () => {
    const dictionary = resolveSkillDictionary({
      getSkillDictionary: () => skillSeed.skills.map((s) => s.name),
    });
    const found = extractSkills(bio, dictionary);
    expect(found).toContain("adobe photoshop");
    expect(found).toContain("seo");
  });

  it("contains no bare 1–2 char alphabetic tokens that match common words", () => {
    const ambiguous = skillSeed.skills.filter((s) => /^[a-z]{1,2}$/.test(s.name));
    expect(ambiguous).toEqual([]);
  });

  it("does not false-positive on common words like 'go' and 'r'", () => {
    const dictionary = skillSeed.skills.map((s) => s.name);
    const found = extractSkills("We go to market fast and invest in R&D.", dictionary);
    expect(found).not.toContain("go");
    expect(found).not.toContain("r");
  });
});

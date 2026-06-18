import { extractSkills } from "../domain/extract-skills.js";
import { normalizeSkill } from "../domain/normalize.js";
import type { SkillProfile } from "../domain/types.js";

export type BuildProfileInput = {
  resumeText?: string;
  manualSkills?: string[];
  roleKeywords?: string[];
  categories?: string[];
  yearsExperience?: number;
  dictionary?: string[];
};

export function buildProfile(input: BuildProfileInput): SkillProfile {
  const fromResume = input.resumeText ? extractSkills(input.resumeText, input.dictionary) : [];
  const fromManual = (input.manualSkills ?? []).map(normalizeSkill);
  const skills = [...new Set([...fromResume, ...fromManual])];
  const roleKeywords = [...new Set((input.roleKeywords ?? []).map(normalizeSkill))];

  return {
    skills,
    roleKeywords,
    categories: input.categories ?? [],
    yearsExperience: input.yearsExperience,
  };
}

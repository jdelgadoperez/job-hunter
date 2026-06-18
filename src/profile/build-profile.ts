import { extractSkills } from "@app/domain/extract-skills";
import { normalizeSkill } from "@app/domain/normalize";
import type { SkillProfile } from "@app/domain/types";

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

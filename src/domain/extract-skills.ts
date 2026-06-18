import { normalizeSkill } from "./normalize.js";
import { DEFAULT_SKILL_DICTIONARY } from "./skill-dictionary.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function skillPattern(skill: string): RegExp {
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(skill.toLowerCase())}(?![a-z0-9])`, "i");
}

export function extractSkills(
  text: string,
  dictionary: string[] = DEFAULT_SKILL_DICTIONARY,
): string[] {
  const found = new Set<string>();
  for (const skill of dictionary) {
    if (skillPattern(skill).test(text)) {
      found.add(normalizeSkill(skill));
    }
  }
  return [...found];
}

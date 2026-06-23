import { normalizeSkill } from "./normalize";
import { DEFAULT_SKILL_DICTIONARY } from "./skill-dictionary";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Compiling a word-boundary regex per skill is the hot inner step of every scan (dictionary ×
// postings), and the patterns are immutable, so memoize them across calls.
const patternCache = new Map<string, RegExp>();

function skillPattern(skill: string): RegExp {
  let pattern = patternCache.get(skill);
  if (!pattern) {
    pattern = new RegExp(`(?<![a-z0-9])${escapeRegExp(skill.toLowerCase())}(?![a-z0-9])`, "i");
    patternCache.set(skill, pattern);
  }
  return pattern;
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

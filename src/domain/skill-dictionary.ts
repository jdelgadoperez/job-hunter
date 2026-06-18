// Offline / empty-DB fallback. This is an engineering-only starter list; the broad,
// multi-domain dictionary lives in the seeded `skills` table (see skill-seed.json),
// and `resolveSkillDictionary` prefers it when present.
export const DEFAULT_SKILL_DICTIONARY: string[] = [
  "TypeScript",
  "JavaScript",
  "Node.js",
  "React",
  "Angular",
  "NestJS",
  "Python",
  "Go",
  "Java",
  "SQL",
  "PostgreSQL",
  "MySQL",
  "AWS",
  "Terraform",
  "Docker",
  "Kubernetes",
  "GraphQL",
  "REST",
  "Temporal",
  "Bash",
];

/**
 * Resolve the skill dictionary the extractor should use: prefer the repository's
 * seeded (broad, multi-domain) dictionary, and fall back to the engineering-only
 * constant when the database is unseeded or unavailable.
 */
export function resolveSkillDictionary(repo?: { getSkillDictionary(): string[] }): string[] {
  const seeded = repo?.getSkillDictionary() ?? [];
  return seeded.length > 0 ? seeded : DEFAULT_SKILL_DICTIONARY;
}

import { buildProfile } from "@app/profile/build-profile";
import type { Repository } from "@app/storage/repository";

const ANTHROPIC_KEY_SETTING = "anthropicApiKey";

export type SetupAnswers = {
  /** Anthropic API key. Blank/omitted → LLM scoring degrades to the heuristic. */
  apiKey?: string;
  /** Resume text (already read from disk by the caller). Blank/omitted → no profile built. */
  resumeText?: string;
};

export type SetupResult = {
  savedApiKey: boolean;
  /** Number of skills extracted, or null when no resume was provided. */
  profileSkills: number | null;
};

/** Seed the skill dictionary into the repository; returns the resulting dictionary size. */
export function seedSkillDictionary(
  repo: Repository,
  skills: { name: string; category: string }[],
): number {
  repo.seedSkills(skills);
  return repo.getSkillDictionary().length;
}

/**
 * Persist first-run configuration: the API key (if any) and a profile built from the resume text
 * (if any). The Airtable directory is a fixed community resource (see `resolveShareUrl`), so it is
 * not configured here. Pure with respect to I/O — the caller reads the resume file and passes the
 * text — so it is unit-tested directly.
 */
export function applyConfig(repo: Repository, answers: SetupAnswers): SetupResult {
  const apiKey = answers.apiKey?.trim();
  if (apiKey) repo.setSetting(ANTHROPIC_KEY_SETTING, apiKey);

  let profileSkills: number | null = null;
  const resumeText = answers.resumeText?.trim();
  if (resumeText) {
    const dictionary = repo.getSkillDictionary();
    const profile = buildProfile({
      resumeText,
      dictionary: dictionary.length > 0 ? dictionary : undefined,
    });
    repo.saveProfile(profile);
    profileSkills = profile.skills.length;
  }

  return { savedApiKey: Boolean(apiKey), profileSkills };
}

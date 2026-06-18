import { extractSkills } from "@app/domain/extract-skills";
import type { JobPosting, MatchResult, Scorer, SkillProfile } from "@app/domain/types";

const SKILL_WEIGHT = 0.8;
const TITLE_WEIGHT = 0.2;

export class HeuristicScorer implements Scorer {
  constructor(private readonly dictionary?: string[]) {}

  score(profile: SkillProfile, posting: JobPosting): MatchResult {
    const text = `${posting.title}\n${posting.description}`;
    const postingSkills = extractSkills(text, this.dictionary);
    const profileSkills = new Set(profile.skills);

    const matchedSkills = postingSkills.filter((skill) => profileSkills.has(skill));
    const missingSkills = postingSkills.filter((skill) => !profileSkills.has(skill));

    const skillFraction =
      postingSkills.length === 0 ? 0 : matchedSkills.length / postingSkills.length;
    const titleFraction = this.titleKeywordFraction(profile.roleKeywords, posting.title);

    const score = Math.round((skillFraction * SKILL_WEIGHT + titleFraction * TITLE_WEIGHT) * 100);

    return { score, matchedSkills, missingSkills };
  }

  private titleKeywordFraction(roleKeywords: string[], title: string): number {
    if (roleKeywords.length === 0) return 0;
    const haystack = title.toLowerCase();
    const hits = roleKeywords.filter((keyword) => haystack.includes(keyword)).length;
    return hits / roleKeywords.length;
  }
}

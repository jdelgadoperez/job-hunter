export type SkillProfile = {
  skills: string[];
  roleKeywords: string[];
  categories: string[];
  yearsExperience?: number;
};

export type JobPosting = {
  id: string;
  company: string;
  title: string;
  url: string;
  source: string;
  description: string;
  location?: string;
  postedAt?: Date;
  fetchedAt: Date;
};

export type MatchResult = {
  score: number;
  matchedSkills: string[];
  missingSkills: string[];
  rationale?: string;
};

export type LiveStatus = "live" | "expired" | "unknown";

export type Warning = {
  source: string;
  message: string;
};

export interface Scorer {
  score(profile: SkillProfile, posting: JobPosting): MatchResult | Promise<MatchResult>;
}

export type SkillProfile = {
  skills: string[];
  roleKeywords: string[];
  categories: string[];
  yearsExperience?: number;
};

export type JobPosting = {
  id: string;
  // For ATS-sourced postings this is the board token (the careers-URL slug), which
  // `fetchLivenessSignal` re-uses to re-fetch the feed; the browser fallback stores the
  // human-readable company name. Keep this contract in mind before "fixing" it to always
  // be a display name — doing so would break ATS liveness re-fetching.
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

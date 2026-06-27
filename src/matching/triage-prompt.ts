import type { SkillProfile } from "@app/domain/types";

export type TriageItem = { id: string; title: string; location?: string };

export type LlmTriageRequest = {
  /** Stable, cacheable prefix: triage instructions + the serialized profile. */
  system: string;
  /** Volatile per-batch content: the candidate titles. */
  user: string;
};

const INSTRUCTIONS = `You triage job titles for a job-search tool to decide which deserve a full, expensive review.

Given the candidate's skill profile (below) and a batch of job titles (in the user message), return one decision per title:
- id: the title's id, copied exactly from the input.
- keep: true if the role is plausibly worth a full review, false for a clear mismatch.
- reason: a short phrase explaining the decision.

Keep generously: equivalent technologies, adjacent roles, and plausible seniority matches should be kept. Drop only clear mismatches — wrong domain (e.g. sales, marketing, recruiting for an engineer), wrong discipline, or obviously wrong seniority. Return a decision for every id, and only ids present in the input.`;

function serializeProfile(profile: SkillProfile): string {
  const lines = [
    `Skills: ${profile.skills.join(", ") || "(none listed)"}`,
    `Role keywords: ${profile.roleKeywords.join(", ") || "(none listed)"}`,
    `Categories: ${profile.categories.join(", ") || "(none listed)"}`,
  ];
  if (profile.yearsExperience !== undefined) {
    lines.push(`Years of experience: ${profile.yearsExperience}`);
  }
  return lines.join("\n");
}

function serializeItem(item: TriageItem): string {
  const location = item.location ? ` [${item.location}]` : "";
  return `- id=${item.id} :: ${item.title}${location}`;
}

/**
 * Build the `{ system, user }` triage request. The profile + instructions form the cacheable
 * system prefix (byte-identical across batches in a run); the titles are the volatile user turn.
 */
export function buildTriagePrompt(profile: SkillProfile, items: TriageItem[]): LlmTriageRequest {
  return {
    system: `${INSTRUCTIONS}\n\n## Candidate profile\n${serializeProfile(profile)}`,
    user: `## Titles to triage\n${items.map(serializeItem).join("\n")}`,
  };
}

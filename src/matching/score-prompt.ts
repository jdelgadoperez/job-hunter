import type { JobPosting, MatchResult, SkillProfile } from "@app/domain/types";
import type { LlmScoreRequest } from "./llm-client";
import type { LlmMatchPayload } from "./llm-schema";

const INSTRUCTIONS = `You score how well a candidate matches a job posting for a job-search tool.

Given the candidate's skill profile (below) and a job posting (in the user message), return:
- score: an integer 0-100 measuring overall semantic alignment between the candidate and the role.
- matchedSkills: skills from the candidate's profile that the posting requires or values.
- missingSkills: skills the posting requires that are absent from the candidate's profile.
- rationale: one short paragraph explaining the score, referencing the strongest matches and gaps.

Judge meaning, not surface keywords: treat equivalent technologies and adjacent experience as matches.
Be honest about gaps. Return only the structured fields.`;

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

const REMOTE_PREFERENCE_NOTE =
  "Note: the user prefers remote roles — weight remote-friendly indicators slightly higher when scores are otherwise close.";

/**
 * Build the `{ system, user }` request. The profile + instructions go in `system` (the stable,
 * cacheable prefix across every posting in a run); the posting goes in `user` (the volatile
 * part). Pure and deterministic: identical profiles + remoteOnly flag produce byte-identical
 * `system` strings.
 *
 * When `remoteOnly` is true, a one-line remote-preference note is appended to the system prefix
 * so the LLM weighs remote-friendly signals slightly higher. Omitting the flag is equivalent to
 * `false` and preserves the original system prompt byte-for-byte.
 */
export function buildScorePrompt(
  profile: SkillProfile,
  posting: JobPosting,
  remoteOnly = false,
): LlmScoreRequest {
  const systemBase = `${INSTRUCTIONS}\n\n## Candidate profile\n${serializeProfile(profile)}`;
  const system = remoteOnly ? `${systemBase}\n\n${REMOTE_PREFERENCE_NOTE}` : systemBase;
  return {
    system,
    user: `## Job posting\nTitle: ${posting.title}\n\nDescription:\n${posting.description}`,
  };
}

/** Map a validated payload to a `MatchResult`, clamping the score to a rounded 0-100. */
export function toMatchResult(payload: LlmMatchPayload): MatchResult {
  const score = Math.round(Math.min(100, Math.max(0, payload.score)));
  return {
    score,
    matchedSkills: payload.matchedSkills,
    missingSkills: payload.missingSkills,
    rationale: payload.rationale,
  };
}

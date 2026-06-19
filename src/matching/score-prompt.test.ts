import type { JobPosting, SkillProfile } from "@app/domain/types";
import { describe, expect, it } from "vitest";
import type { LlmMatchPayload } from "./llm-schema";
import { buildScorePrompt, toMatchResult } from "./score-prompt";

const profile: SkillProfile = {
  skills: ["typescript", "react"],
  roleKeywords: ["frontend engineer"],
  categories: ["Engineering"],
  yearsExperience: 8,
};

function posting(overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    id: "1",
    company: "Acme",
    title: "Frontend Engineer",
    url: "https://example.com/1",
    source: "test",
    description: "We need TypeScript and React.",
    fetchedAt: new Date(0),
    ...overrides,
  };
}

describe("buildScorePrompt", () => {
  it("puts the profile in system and the posting in user", () => {
    const { system, user } = buildScorePrompt(profile, posting());
    expect(system).toContain("typescript");
    expect(system).toContain("frontend engineer");
    expect(system).toContain("Engineering");
    expect(user).toContain("Frontend Engineer");
    expect(user).toContain("We need TypeScript and React.");
  });

  it("produces a byte-identical system string for identical profiles (cache stability)", () => {
    const a = buildScorePrompt(profile, posting({ description: "A" }));
    const b = buildScorePrompt(profile, posting({ description: "B" }));
    expect(a.system).toBe(b.system);
  });

  it("never leaks the posting into the cacheable system prefix", () => {
    const { system } = buildScorePrompt(profile, posting({ description: "SECRET-POSTING-TEXT" }));
    expect(system).not.toContain("SECRET-POSTING-TEXT");
  });
});

describe("toMatchResult", () => {
  const base: LlmMatchPayload = {
    score: 73,
    matchedSkills: ["typescript"],
    missingSkills: ["go"],
    rationale: "Good overlap.",
  };

  it("preserves skills and rationale", () => {
    expect(toMatchResult(base)).toEqual({
      score: 73,
      matchedSkills: ["typescript"],
      missingSkills: ["go"],
      rationale: "Good overlap.",
    });
  });

  it("clamps and rounds the score", () => {
    expect(toMatchResult({ ...base, score: 120 }).score).toBe(100);
    expect(toMatchResult({ ...base, score: -5 }).score).toBe(0);
    expect(toMatchResult({ ...base, score: 72.6 }).score).toBe(73);
  });
});

import type { JobPosting, SkillProfile } from "@app/domain/types";
import { describe, expect, it } from "vitest";
import { applyRemotePenalty, HeuristicScorer, REMOTE_PENALTY_FACTOR } from "./heuristic-scorer";

function posting(overrides: Partial<JobPosting>): JobPosting {
  return {
    id: "1",
    company: "Acme",
    title: "Engineer",
    url: "https://example.com/1",
    source: "test",
    description: "",
    fetchedAt: new Date(0),
    ...overrides,
  };
}

const profile: SkillProfile = {
  skills: ["typescript", "react"],
  roleKeywords: ["frontend engineer"],
  categories: [],
};

describe("HeuristicScorer", () => {
  const scorer = new HeuristicScorer();

  it("identifies matched and missing skills from the posting", () => {
    const result = scorer.score(
      profile,
      posting({ description: "We need TypeScript, React, and Go." }),
    );
    expect(result.matchedSkills.sort()).toEqual(["react", "typescript"]);
    expect(result.missingSkills).toContain("go");
  });

  it("keeps the score within 0..100", () => {
    const result = scorer.score(profile, posting({ description: "TypeScript React Go AWS" }));
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("scores a fully-matching posting higher than a partially-matching one", () => {
    const full = scorer.score(profile, posting({ description: "TypeScript and React." }));
    const partial = scorer.score(profile, posting({ description: "TypeScript, React, Go, AWS." }));
    expect(full.score).toBeGreaterThan(partial.score);
  });

  it("rewards a role-keyword match in the title", () => {
    const withTitle = scorer.score(
      profile,
      posting({ title: "Frontend Engineer", description: "TypeScript, Go." }),
    );
    const withoutTitle = scorer.score(
      profile,
      posting({ title: "Data Scientist", description: "TypeScript, Go." }),
    );
    expect(withTitle.score).toBeGreaterThan(withoutTitle.score);
  });
});

describe("REMOTE_PENALTY_FACTOR", () => {
  it("is 0.6", () => {
    expect(REMOTE_PENALTY_FACTOR).toBe(0.6);
  });
});

describe("applyRemotePenalty", () => {
  const cases: Array<[number, number]> = [
    [100, Math.round(100 * REMOTE_PENALTY_FACTOR)],
    [80, Math.round(80 * REMOTE_PENALTY_FACTOR)],
    [50, Math.round(50 * REMOTE_PENALTY_FACTOR)],
    [0, 0],
    [1, Math.round(1 * REMOTE_PENALTY_FACTOR)],
  ];

  for (const [input, expected] of cases) {
    it(`score ${input} → ${expected}`, () => {
      const result = { score: input, matchedSkills: ["ts"], missingSkills: [] };
      expect(applyRemotePenalty(result).score).toBe(expected);
    });
  }

  it("does not modify matchedSkills or missingSkills", () => {
    const result = { score: 80, matchedSkills: ["typescript"], missingSkills: ["go"] };
    const penalized = applyRemotePenalty(result);
    expect(penalized.matchedSkills).toEqual(["typescript"]);
    expect(penalized.missingSkills).toEqual(["go"]);
  });

  it("clamped score is never negative", () => {
    expect(applyRemotePenalty({ score: 0, matchedSkills: [], missingSkills: [] }).score).toBe(0);
  });

  it("a strong on-site score (90) penalized still exceeds a weak unpenalized score (40)", () => {
    const strongOnSite = applyRemotePenalty({ score: 90, matchedSkills: [], missingSkills: [] });
    expect(strongOnSite.score).toBeGreaterThan(40);
  });

  it("preserves optional rationale field when present", () => {
    const result = {
      score: 80,
      matchedSkills: ["typescript"],
      missingSkills: ["go"],
      rationale: "Strong TypeScript match",
    };
    const penalized = applyRemotePenalty(result);
    expect(penalized.rationale).toBe("Strong TypeScript match");
  });
});

import type { JobPosting, SkillProfile } from "@app/domain/types";
import { describe, expect, it } from "vitest";
import { HeuristicScorer } from "./heuristic-scorer";

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

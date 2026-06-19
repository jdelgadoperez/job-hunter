import type { JobPosting, SkillProfile, Warning } from "@app/domain/types";
import { describe, expect, it } from "vitest";
import { HeuristicScorer } from "./heuristic-scorer";
import { FakeLlmClient } from "./llm-client";
import type { LlmMatchPayload } from "./llm-schema";
import { LlmScorer } from "./llm-scorer";

const profile: SkillProfile = {
  skills: ["typescript", "react"],
  roleKeywords: ["frontend engineer"],
  categories: [],
};

const posting: JobPosting = {
  id: "1",
  company: "Acme",
  title: "Frontend Engineer",
  url: "https://example.com/1",
  source: "test",
  description: "TypeScript, React, Go.",
  fetchedAt: new Date(0),
};

const goodPayload: LlmMatchPayload = {
  score: 88,
  matchedSkills: ["typescript", "react"],
  missingSkills: ["go"],
  rationale: "Strong overlap on the frontend stack.",
};

describe("LlmScorer", () => {
  it("maps a valid payload to a MatchResult without warning", async () => {
    const warnings: Warning[] = [];
    const scorer = new LlmScorer(new FakeLlmClient(goodPayload), new HeuristicScorer(), (w) =>
      warnings.push(w),
    );
    const result = await scorer.score(profile, posting);
    expect(result.score).toBe(88);
    expect(result.rationale).toBe("Strong overlap on the frontend stack.");
    expect(warnings).toEqual([]);
  });

  it("falls back to the heuristic and warns on an API error", async () => {
    const warnings: Warning[] = [];
    const fallback = new HeuristicScorer();
    const scorer = new LlmScorer(new FakeLlmClient(new Error("503")), fallback, (w) =>
      warnings.push(w),
    );
    const result = await scorer.score(profile, posting);
    expect(result).toEqual(fallback.score(profile, posting));
    expect(result.rationale).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.source).toBe("llm-scorer");
  });

  it("falls back to the heuristic and warns on a malformed payload", async () => {
    const warnings: Warning[] = [];
    const fallback = new HeuristicScorer();
    // Cast a malformed object past the type to exercise the safeParse boundary.
    const malformed = { score: 999, matchedSkills: "nope" } as unknown as LlmMatchPayload;
    const scorer = new LlmScorer(new FakeLlmClient(malformed), fallback, (w) => warnings.push(w));
    const result = await scorer.score(profile, posting);
    expect(result).toEqual(fallback.score(profile, posting));
    expect(warnings).toHaveLength(1);
  });

  it("never rejects, even without an onWarning callback", async () => {
    const scorer = new LlmScorer(new FakeLlmClient(new Error("boom")), new HeuristicScorer());
    await expect(scorer.score(profile, posting)).resolves.toBeDefined();
  });
});

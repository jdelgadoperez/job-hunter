import type { JobPosting, SkillProfile, Warning } from "@app/domain/types";
import { describe, expect, it } from "vitest";
import { createAbortingScorer } from "./aborting-scorer";
import { HeuristicScorer } from "./heuristic-scorer";
import { FakeLlmClient } from "./llm-client";
import type { LlmMatchPayload } from "./llm-schema";

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
  rationale: "Strong overlap.",
};

function build(response: LlmMatchPayload | Error) {
  const warnings: Warning[] = [];
  const scorer = createAbortingScorer({
    client: new FakeLlmClient(response),
    heuristic: new HeuristicScorer(["typescript", "react", "go"]),
    remoteOnly: false,
    onWarning: (w) => warnings.push(w),
  });
  return { scorer, warnings };
}

describe("createAbortingScorer", () => {
  it("returns the LLM result on a valid payload", async () => {
    const { scorer, warnings } = build(goodPayload);
    const result = await scorer.score(profile, posting);
    expect(result.score).toBe(goodPayload.score);
    expect(result.matchedSkills).toEqual(goodPayload.matchedSkills);
    expect(warnings).toHaveLength(0);
  });

  it("re-throws a usage-limit error so the run can abort", async () => {
    const { scorer, warnings } = build(new Error("usage limit reached"));
    await expect(scorer.score(profile, posting)).rejects.toThrow(/usage limit/i);
    // A usage-limit abort is NOT a degradation, so it emits no warning here.
    expect(warnings).toHaveLength(0);
  });

  it("degrades an ordinary error to the heuristic scorer with a warning", async () => {
    const { scorer, warnings } = build(new Error("network down"));
    const result = await scorer.score(profile, posting);
    // The heuristic still produces a score (non-negative), and a warning explains the fallback.
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.source).toBe("llm-scorer");
    expect(warnings[0]?.message).toMatch(/using the heuristic scorer/i);
  });
});

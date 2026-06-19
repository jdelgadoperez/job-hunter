import { describe, expect, it } from "vitest";
import { MatchPayloadSchema } from "./llm-schema";

const valid = {
  score: 72,
  matchedSkills: ["typescript", "react"],
  missingSkills: ["go"],
  rationale: "Strong frontend overlap; missing Go.",
};

describe("MatchPayloadSchema", () => {
  it("accepts a well-formed payload", () => {
    expect(MatchPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a score above 100", () => {
    expect(MatchPayloadSchema.safeParse({ ...valid, score: 120 }).success).toBe(false);
  });

  it("rejects a missing field", () => {
    const { rationale, ...withoutRationale } = valid;
    expect(MatchPayloadSchema.safeParse(withoutRationale).success).toBe(false);
  });

  it("rejects wrong types", () => {
    expect(MatchPayloadSchema.safeParse({ ...valid, matchedSkills: "react" }).success).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(MatchPayloadSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
});

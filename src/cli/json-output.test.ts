import type { ScoredPosting } from "@app/storage/repository";
import { describe, expect, it } from "vitest";
import { MatchJsonSchema, toMatchJson } from "./json-output";

function scoredFixture(overrides: Partial<ScoredPosting> = {}): ScoredPosting {
  return {
    posting: {
      id: "p1",
      company: "acme",
      title: "Staff Engineer",
      url: "https://acme.example/jobs/1",
      source: "greenhouse",
      description: "desc",
      remote: true,
      fetchedAt: new Date("2026-07-01T00:00:00.000Z"),
    },
    result: { score: 87, matchedSkills: [], missingSkills: [] },
    action: null,
    expired: false,
    ...overrides,
  };
}

describe("toMatchJson", () => {
  it("flattens a scored posting into the JSON contract and validates against the schema", () => {
    const [record] = toMatchJson([scoredFixture()]);
    expect(() => MatchJsonSchema.parse(record)).not.toThrow();
    expect(record).toMatchObject({
      score: 87,
      company: "acme",
      title: "Staff Engineer",
      url: "https://acme.example/jobs/1",
      source: "greenhouse",
      remote: true,
      applied: false,
      expired: false,
      location: null,
      country: null,
      postedAt: null,
    });
  });

  it("serializes dates as ISO strings and maps action=applied to applied:true", () => {
    const [record] = toMatchJson([
      scoredFixture({
        posting: { ...scoredFixture().posting, postedAt: new Date("2026-06-01T00:00:00.000Z") },
        action: "applied",
      }),
    ]);
    expect(record?.postedAt).toBe("2026-06-01T00:00:00.000Z");
    expect(record?.applied).toBe(true);
  });
});

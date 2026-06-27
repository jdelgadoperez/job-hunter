import type { JobPosting } from "@app/domain/types";
import { describe, expect, it } from "vitest";
import { type PostingRow, postingToRow, rowToPosting } from "./postgres-mappers";

function posting(overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    id: "gh:acme:1",
    company: "acme",
    title: "Senior TypeScript Engineer",
    url: "https://boards.greenhouse.io/acme/jobs/1",
    source: "greenhouse",
    description: "TypeScript and React.",
    location: "Remote - US",
    postedAt: new Date("2026-06-20T00:00:00.000Z"),
    fetchedAt: new Date("2026-06-26T12:00:00.000Z"),
    ...overrides,
  };
}

describe("postgres mappers", () => {
  it("round-trips a fully-populated posting, preserving the id and every field", () => {
    const original = posting();
    const restored = rowToPosting(postingToRow(original) as PostingRow);
    expect(restored).toEqual(original);
    // Identity parity is the whole point: the id must survive the worker's store unchanged so the
    // client's saved scores / actions stay attached when it later reads the same posting from the feed.
    expect(restored.id).toBe(original.id);
  });

  it("omits absent optionals (location / postedAt) rather than emitting nulls", () => {
    const original = posting({ location: undefined, postedAt: undefined });
    const row = postingToRow(original);
    expect(row.location).toBeNull();
    expect(row.posted_at).toBeNull();

    const restored = rowToPosting(row as PostingRow);
    expect("location" in restored).toBe(false);
    expect("postedAt" in restored).toBe(false);
    expect(restored).toEqual(original);
  });

  it("coerces driver-supplied Date timestamps the same as ISO strings", () => {
    // The postgres driver hands back Date objects for timestamptz; reads must handle that too.
    const fetchedAt = new Date("2026-06-26T12:00:00.000Z");
    const row: PostingRow = {
      id: "x",
      company: "c",
      title: "t",
      url: "u",
      source: "s",
      description: "d",
      location: null,
      posted_at: new Date("2026-06-20T00:00:00.000Z"),
      fetched_at: fetchedAt,
    };
    const restored = rowToPosting(row);
    expect(restored.fetchedAt.getTime()).toBe(fetchedAt.getTime());
    expect(restored.postedAt?.toISOString()).toBe("2026-06-20T00:00:00.000Z");
  });
});

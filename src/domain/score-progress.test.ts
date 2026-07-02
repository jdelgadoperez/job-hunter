import { describe, expect, it } from "vitest";
import { formatScoreProgress, type ScoreProgressEvent } from "./score-progress";

describe("formatScoreProgress", () => {
  const cases: [ScoreProgressEvent, string][] = [
    [{ kind: "planning" }, "Planning the deep-score run…"],
    [{ kind: "triaging", total: 1 }, "Triaging 1 title…"],
    [{ kind: "triaging", total: 42 }, "Triaging 42 titles…"],
    [{ kind: "triaged", kept: 1, total: 1 }, "Kept 1 of 1 title after triage"],
    [{ kind: "triaged", kept: 12, total: 42 }, "Kept 12 of 42 titles after triage"],
    [{ kind: "scoring", index: 3, total: 10, title: "Senior Engineer" }, "[3/10] Senior Engineer"],
    [{ kind: "done", deepScored: 0 }, "Deep-scored 0 postings"],
    [{ kind: "done", deepScored: 1 }, "Deep-scored 1 posting"],
    [{ kind: "done", deepScored: 118 }, "Deep-scored 118 postings"],
  ];

  for (const [event, expected] of cases) {
    it(`formats ${event.kind} (${expected})`, () => {
      expect(formatScoreProgress(event)).toBe(expected);
    });
  }
});

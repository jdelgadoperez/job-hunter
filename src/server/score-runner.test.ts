import type { ScoreProgressEvent } from "@app/domain/score-progress";
import { describe, expect, it } from "vitest";
import { shouldLogToTerminal } from "./score-runner";

describe("shouldLogToTerminal", () => {
  it("always logs non-scoring stage events", () => {
    const stages: ScoreProgressEvent[] = [
      { kind: "planning" },
      { kind: "triaging", total: 40 },
      { kind: "triaged", kept: 12, total: 40 },
      { kind: "done", deepScored: 12 },
    ];
    for (const event of stages) expect(shouldLogToTerminal(event)).toBe(true);
  });

  it("logs only every 10th scoring tick plus the final one", () => {
    const total = 118;
    const logged: number[] = [];
    for (let index = 1; index <= total; index++) {
      if (shouldLogToTerminal({ kind: "scoring", index, total, title: "x" })) logged.push(index);
    }
    // Every multiple of 10, and the last tick even though 118 isn't a multiple of 10.
    const expected = [
      ...Array.from({ length: Math.floor(total / 10) }, (_, i) => (i + 1) * 10),
      total,
    ];
    expect(logged).toEqual(expected);
  });

  it("does not double-log the final tick when the total is a multiple of 10", () => {
    const total = 30;
    const logged: number[] = [];
    for (let index = 1; index <= total; index++) {
      if (shouldLogToTerminal({ kind: "scoring", index, total, title: "x" })) logged.push(index);
    }
    expect(logged).toEqual([10, 20, 30]);
  });
});

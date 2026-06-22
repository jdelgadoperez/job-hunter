import { describe, expect, it } from "vitest";
import { type ScanProgressEvent, formatProgress } from "./scan-progress";

describe("formatProgress", () => {
  const cases: [ScanProgressEvent, string][] = [
    [{ kind: "directory" }, "Reading the company directory (this can take ~30s)…"],
    [{ kind: "leads", total: 1 }, "Found 1 company to scan"],
    [{ kind: "leads", total: 42 }, "Found 42 companies to scan"],
    [{ kind: "company", name: "Acme", index: 3, total: 10 }, "[3/10] Acme"],
    [{ kind: "scoring", total: 1 }, "Scoring 1 posting…"],
    [{ kind: "scoring", total: 5 }, "Scoring 5 postings…"],
    [{ kind: "summary", count: 0 }, "Scanned and scored 0 postings"],
    [{ kind: "summary", count: 1 }, "Scanned and scored 1 posting"],
  ];

  for (const [event, expected] of cases) {
    it(`formats ${event.kind} (${expected})`, () => {
      expect(formatProgress(event)).toBe(expected);
    });
  }
});

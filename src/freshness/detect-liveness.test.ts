import { describe, expect, it } from "vitest";
import { type LivenessSignal, detectLiveness } from "./detect-liveness";

function http(overrides: Partial<Extract<LivenessSignal, { kind: "http" }>>): LivenessSignal {
  return {
    kind: "http",
    statusCode: 200,
    originalUrl: "https://example.com/job/1",
    finalUrl: "https://example.com/job/1",
    bodyText: "Apply now for this great role.",
    ...overrides,
  };
}

describe("detectLiveness", () => {
  it("treats an ATS feed containing the posting as live", () => {
    expect(detectLiveness({ kind: "ats-feed", postingPresent: true })).toBe("live");
  });

  it("treats an ATS feed missing the posting as expired", () => {
    expect(detectLiveness({ kind: "ats-feed", postingPresent: false })).toBe("expired");
  });

  it("treats 404/410 as expired", () => {
    expect(detectLiveness(http({ statusCode: 404 }))).toBe("expired");
    expect(detectLiveness(http({ statusCode: 410 }))).toBe("expired");
  });

  it("treats expired-marker copy as expired", () => {
    expect(detectLiveness(http({ bodyText: "This position has been filled. Thank you." }))).toBe(
      "expired",
    );
  });

  it("treats a healthy 2xx page as live", () => {
    expect(detectLiveness(http({ statusCode: 200 }))).toBe("live");
  });

  it("treats other status codes as unknown", () => {
    expect(detectLiveness(http({ statusCode: 503 }))).toBe("unknown");
  });
});

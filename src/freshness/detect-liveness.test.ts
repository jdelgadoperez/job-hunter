import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import expiredMarkers from "./data/expired-markers.json";
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

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), "utf8");
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

describe("expired-marker validation against captured fixtures", () => {
  const fixtures = [
    "expired-greenhouse.html",
    "expired-lever.html",
    "expired-ashby.html",
    "expired-generic.html",
  ];

  for (const name of fixtures) {
    it(`classifies ${name} as expired on a 200 response`, () => {
      expect(detectLiveness(http({ statusCode: 200, bodyText: fixture(name) }))).toBe("expired");
    });
  }

  it("classifies a captured live page as live", () => {
    expect(
      detectLiveness(http({ statusCode: 200, bodyText: fixture("live-greenhouse.html") })),
    ).toBe("live");
  });

  it("every retained marker matches at least one captured fixture", () => {
    const corpus = fixtures.map((name) => fixture(name).toLowerCase());
    for (const entry of expiredMarkers.markers) {
      const matched = corpus.some((html) => html.includes(entry.marker));
      // A marker with no real-page evidence must be explicitly flagged unverified.
      expect(matched || "unverified" in entry).toBe(true);
    }
  });
});

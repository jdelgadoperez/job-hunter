import { describe, expect, it } from "vitest";
import { normalizeCareersUrl, normalizeSkill } from "./normalize";

describe("normalizeSkill", () => {
  it("lower-cases, trims, and collapses whitespace", () => {
    const raw = "  Type   Script ";
    expect(normalizeSkill(raw)).toBe("type script");
  });

  it("maps known aliases to a canonical form", () => {
    expect(normalizeSkill("Node.js")).toBe(normalizeSkill("nodejs"));
    expect(normalizeSkill("React.js")).toBe("react");
    expect(normalizeSkill("TS")).toBe("typescript");
  });

  it("leaves unknown skills unchanged except for casing/spacing", () => {
    expect(normalizeSkill("Kubernetes")).toBe("kubernetes");
  });
});

describe("normalizeCareersUrl", () => {
  it("lower-cases the origin and path", () => {
    expect(normalizeCareersUrl("https://Acme.com/Careers")).toBe("https://acme.com/careers");
  });

  it("strips a trailing slash", () => {
    expect(normalizeCareersUrl("https://acme.com/careers/")).toBe("https://acme.com/careers");
  });

  it("drops query strings and hash fragments", () => {
    expect(normalizeCareersUrl("https://acme.com/careers?ref=abc#top")).toBe(
      "https://acme.com/careers",
    );
  });

  it("falls back to a trimmed, lower-cased string when the URL doesn't parse", () => {
    expect(normalizeCareersUrl("  Not A URL ")).toBe("not a url");
  });
});

import { describe, expect, it } from "vitest";
import { normalizeSkill } from "./normalize";

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

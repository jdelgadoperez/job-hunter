import { describe, expect, it } from "vitest";
import { extractSkills } from "./extract-skills";
import { normalizeSkill } from "./normalize";

const DICT = ["TypeScript", "React", "Node.js", "AWS", "Go"];

describe("extractSkills", () => {
  it("finds dictionary skills present in the text, normalized", () => {
    const text = "Senior engineer with TypeScript and React experience.";
    const result = extractSkills(text, DICT);
    expect(result).toContain(normalizeSkill("TypeScript"));
    expect(result).toContain(normalizeSkill("React"));
    expect(result).not.toContain(normalizeSkill("Go"));
  });

  it("matches on token boundaries, not substrings", () => {
    const text = "We use Goland the IDE, not the language.";
    const result = extractSkills(text, DICT);
    expect(result).not.toContain(normalizeSkill("Go"));
  });

  it("matches skills containing punctuation", () => {
    const text = "Backend on Node.js services.";
    const result = extractSkills(text, DICT);
    expect(result).toContain(normalizeSkill("Node.js"));
  });

  it("deduplicates repeated mentions", () => {
    const text = "react React REACT";
    const result = extractSkills(text, DICT);
    const reactCount = result.filter((s) => s === normalizeSkill("React")).length;
    expect(reactCount).toBe(1);
  });
});

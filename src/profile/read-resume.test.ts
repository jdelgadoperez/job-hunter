import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extractSkills } from "@app/domain/extract-skills";
import { describe, expect, it } from "vitest";
import { UnsupportedFormatError, readResumeText } from "./read-resume";

function fixture(name: string): string {
  return fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
}

// All fixtures encode the same sentence, so they must yield the same skills. We
// assert on extracted skills rather than exact bytes because PDF text extraction
// is whitespace-noisy.
const EXPECTED_SKILLS = ["typescript", "react", "aws"].sort();

describe("readResumeText", () => {
  it("reads a markdown resume as text", async () => {
    const path = fixture("resume.md");
    const expected = await readFile(path, "utf8");
    expect(await readResumeText(path)).toBe(expected);
  });

  it("reads a plain-text resume as text", async () => {
    const path = fixture("resume.txt");
    const expected = await readFile(path, "utf8");
    expect(await readResumeText(path)).toBe(expected);
  });

  it("extracts the same skills from a PDF resume", async () => {
    const text = await readResumeText(fixture("resume.pdf"));
    expect(extractSkills(text).sort()).toEqual(EXPECTED_SKILLS);
  });

  it("extracts the same skills from a docx resume", async () => {
    const text = await readResumeText(fixture("resume.docx"));
    expect(extractSkills(text).sort()).toEqual(EXPECTED_SKILLS);
  });

  it("throws a typed error for genuinely unsupported formats", async () => {
    await expect(readResumeText("/tmp/resume.rtf")).rejects.toBeInstanceOf(UnsupportedFormatError);
  });
});

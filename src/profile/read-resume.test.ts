import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { UnsupportedFormatError, readResumeText } from "./read-resume.js";

function fixture(name: string): string {
  return fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
}

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

  it("throws a typed error for unsupported formats", async () => {
    await expect(readResumeText("/tmp/resume.pdf")).rejects.toBeInstanceOf(UnsupportedFormatError);
  });
});

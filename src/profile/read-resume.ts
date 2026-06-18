import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export class UnsupportedFormatError extends Error {
  constructor(public readonly ext: string) {
    super(`Unsupported resume format "${ext}". Paste your resume text manually instead.`);
    this.name = "UnsupportedFormatError";
  }
}

const TEXT_EXTENSIONS = new Set([".txt", ".md"]);

export async function readResumeText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) {
    return readFile(filePath, "utf8");
  }
  throw new UnsupportedFormatError(ext);
}

import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export class UnsupportedFormatError extends Error {
  constructor(public readonly ext: string) {
    super(`Unsupported resume format "${ext}". Paste your resume text manually instead.`);
    this.name = "UnsupportedFormatError";
  }
}

const TEXT_EXTENSIONS = new Set([".txt", ".md"]);

async function readPdf(filePath: string): Promise<string> {
  // Dynamic import keeps pdfjs (a heavy dep) out of the hot path until a PDF is read.
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await readFile(filePath));
  const loadingTask = getDocument({ data, useSystemFonts: true });
  try {
    const doc = await loadingTask.promise;
    const pages: string[] = [];
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      const line = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
      pages.push(line);
    }
    return pages.join("\n");
  } finally {
    await loadingTask.destroy();
  }
}

async function readDocx(filePath: string): Promise<string> {
  const { default: mammoth } = await import("mammoth");
  const { value } = await mammoth.extractRawText({ buffer: await readFile(filePath) });
  return value;
}

export async function readResumeText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) {
    return readFile(filePath, "utf8");
  }
  if (ext === ".pdf") {
    return readPdf(filePath);
  }
  if (ext === ".docx") {
    return readDocx(filePath);
  }
  throw new UnsupportedFormatError(ext);
}

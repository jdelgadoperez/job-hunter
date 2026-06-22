import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export class UnsupportedFormatError extends Error {
  constructor(public readonly ext: string) {
    super(`Unsupported resume format "${ext}". Paste your resume text manually instead.`);
    this.name = "UnsupportedFormatError";
  }
}

const TEXT_EXTENSIONS = new Set([".txt", ".md"]);

/** Resume file extensions we can parse. */
export const SUPPORTED_RESUME_EXTENSIONS = new Set([".txt", ".md", ".pdf", ".docx"]);

async function readPdf(data: Uint8Array): Promise<string> {
  // Dynamic import keeps pdfjs (a heavy dep) out of the hot path until a PDF is read.
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdfjs rejects a Node `Buffer` outright, so hand it a plain `Uint8Array`.
  const bytes = data instanceof Buffer ? new Uint8Array(data) : data;
  const loadingTask = getDocument({ data: bytes, useSystemFonts: true });
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

async function readDocx(buffer: Buffer): Promise<string> {
  const { default: mammoth } = await import("mammoth");
  const { value } = await mammoth.extractRawText({ buffer });
  return value;
}

/**
 * Parse resume bytes by extension (`.txt`/`.md`/`.pdf`/`.docx`). The byte-level seam shared by
 * the CLI (which reads from a file path) and the web server (which receives an upload), so neither
 * path needs a temp file. `ext` is the lower-cased extension including the leading dot.
 */
export async function readResumeBuffer(bytes: Uint8Array, ext: string): Promise<string> {
  if (TEXT_EXTENSIONS.has(ext)) {
    return Buffer.from(bytes).toString("utf8");
  }
  if (ext === ".pdf") {
    return readPdf(bytes);
  }
  if (ext === ".docx") {
    return readDocx(Buffer.from(bytes));
  }
  throw new UnsupportedFormatError(ext);
}

export async function readResumeText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  // Reject unsupported formats before touching the filesystem.
  if (!SUPPORTED_RESUME_EXTENSIONS.has(ext)) throw new UnsupportedFormatError(ext);
  return readResumeBuffer(await readFile(filePath), ext);
}

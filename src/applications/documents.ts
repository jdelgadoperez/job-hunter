import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import { ApplicationError } from "./store";

/**
 * Documents attached to an application (interview prep, notes, job descriptions, resumes).
 * Markdown/text "notes" live in the database so they can be edited in the dashboard; every other
 * file (PDF, image, diagram) is copied under the data directory's `docs/` folder and only its path
 * is stored, which keeps the database small.
 */
export type DocumentKind = "note" | "file";

export type DocumentMeta = {
  id: number;
  applicationId: number;
  /** Path relative to the application's workspace, e.g. `prep.md` or `sys-design/arch.png`. */
  name: string;
  kind: DocumentKind;
  mime: string;
  size: number;
  createdAt: string;
  updatedAt: string;
};

export type Note = DocumentMeta & { kind: "note"; content: string };

type DocRow = {
  id: number;
  application_id: number;
  name: string;
  kind: string;
  content: string | null;
  file_path: string | null;
  mime: string;
  size: number;
  created_at: string;
  updated_at: string;
};

const NOTE_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

const MIME_BY_EXTENSION: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".excalidraw": "application/json",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function mimeFor(name: string): string {
  return MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? "application/octet-stream";
}

export function isNoteName(name: string): boolean {
  return NOTE_EXTENSIONS.has(extname(name).toLowerCase());
}

/**
 * Normalize a document name to a safe, forward-slash relative path. Rejects absolute paths, `..`
 * segments, and hidden segments, so a name can never escape the application's docs folder.
 */
export function cleanDocumentName(raw: string): string {
  const trimmed = raw.trim().replaceAll("\\", "/");
  if (!trimmed) throw new ApplicationError("document name is empty");
  if (isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) {
    throw new ApplicationError(`document name must be relative: ${raw}`);
  }
  const parts = trimmed.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0) throw new ApplicationError("document name is empty");
  if (parts.some((p) => p === ".." || p.startsWith("."))) {
    throw new ApplicationError(`invalid document name: ${raw}`);
  }
  return parts.join("/");
}

/** Read-back of a row this store just wrote; a miss means the write silently failed. */
function justWritten<T>(value: T | undefined, name: string): T {
  /* v8 ignore next -- unreachable unless SQLite drops a committed write */
  if (value === undefined) throw new ApplicationError(`failed to save ${name}`);
  return value;
}

export class DocumentStore {
  /** @param docsDir Where non-note files are copied; undefined disables file documents. */
  constructor(
    private readonly db: Database.Database,
    private readonly docsDir: string | undefined,
  ) {}

  list(applicationId: number): DocumentMeta[] {
    const rows = this.db
      .prepare("SELECT * FROM application_documents WHERE application_id = ? ORDER BY name")
      .all(applicationId) as DocRow[];
    return rows.map((r) => this.toMeta(r));
  }

  get(applicationId: number, id: number): DocumentMeta | undefined {
    const row = this.row(applicationId, id);
    return row ? this.toMeta(row) : undefined;
  }

  getByName(applicationId: number, name: string): DocumentMeta | undefined {
    const row = this.rowByName(applicationId, cleanDocumentName(name));
    return row ? this.toMeta(row) : undefined;
  }

  /** A note with its markdown content, or undefined if the id isn't a note on this application. */
  getNote(applicationId: number, id: number): Note | undefined {
    return this.toNote(this.row(applicationId, id));
  }

  /** Create or replace a note by name. */
  saveNote(applicationId: number, name: string, content: string): Note {
    const clean = cleanDocumentName(name);
    if (!isNoteName(clean)) {
      throw new ApplicationError(`notes must be .md, .markdown, or .txt: ${clean}`);
    }
    const existing = this.rowByName(applicationId, clean);
    if (existing && existing.kind !== "note") {
      throw new ApplicationError(`${clean} is a file, not a note`);
    }
    this.db
      .prepare(
        `INSERT INTO application_documents (application_id, name, kind, content, mime, size)
         VALUES (?, ?, 'note', ?, ?, ?)
         ON CONFLICT(application_id, name) DO UPDATE SET
           content = excluded.content, size = excluded.size, updated_at = datetime('now')`,
      )
      .run(applicationId, clean, content, mimeFor(clean), Buffer.byteLength(content));
    return justWritten(this.toNote(this.rowByName(applicationId, clean)), clean);
  }

  /** Update an existing note's content by id. */
  updateNote(applicationId: number, id: number, content: string): Note {
    const note = this.getNote(applicationId, id);
    if (!note) throw new ApplicationError(`no note with id ${id}`);
    return this.saveNote(applicationId, note.name, content);
  }

  /**
   * Attach a file from disk: notes are read into the database, anything else is copied under
   * `docs/<applicationId>/<name>`. Replaces an existing document of the same name.
   */
  attachFile(applicationId: number, sourcePath: string, name: string): DocumentMeta {
    const clean = cleanDocumentName(name);
    if (isNoteName(clean)) {
      return this.saveNote(applicationId, clean, readFileSync(sourcePath, "utf8"));
    }
    const target = this.storagePath(applicationId, clean);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(sourcePath, target);
    const size = statSync(target).size;
    this.db
      .prepare(
        `INSERT INTO application_documents (application_id, name, kind, file_path, mime, size)
         VALUES (?, ?, 'file', ?, ?, ?)
         ON CONFLICT(application_id, name) DO UPDATE SET
           kind = 'file', content = NULL, file_path = excluded.file_path, mime = excluded.mime,
           size = excluded.size, updated_at = datetime('now')`,
      )
      .run(applicationId, clean, target, mimeFor(clean), size);
    const saved = this.rowByName(applicationId, clean);
    return justWritten(saved && this.toMeta(saved), clean);
  }

  /**
   * The bytes of a document for download/preview: a note's text or a file's contents. Returns
   * undefined when the document is gone, including a file missing on disk.
   */
  read(applicationId: number, id: number): { meta: DocumentMeta; body: Buffer } | undefined {
    const row = this.row(applicationId, id);
    if (!row) return undefined;
    const meta = this.toMeta(row);
    if (row.kind === "note") return { meta, body: Buffer.from(row.content ?? "", "utf8") };
    const path = row.file_path ? this.guard(row.file_path) : undefined;
    if (!path || !existsSync(path)) return undefined;
    return { meta, body: readFileSync(path) };
  }

  /** Delete a document (and its stored file). Returns whether it existed. */
  remove(applicationId: number, id: number): boolean {
    const row = this.row(applicationId, id);
    if (!row) return false;
    this.db.prepare("DELETE FROM application_documents WHERE id = ?").run(id);
    if (row.kind === "file" && row.file_path) this.deleteFile(row.file_path);
    return true;
  }

  /** Delete every document of an application, including its stored files. */
  removeAll(applicationId: number): void {
    this.db
      .prepare("DELETE FROM application_documents WHERE application_id = ?")
      .run(applicationId);
    if (this.docsDir) {
      rmSync(join(this.docsDir, String(applicationId)), { recursive: true, force: true });
    }
  }

  private row(applicationId: number, id: number): DocRow | undefined {
    return this.db
      .prepare("SELECT * FROM application_documents WHERE application_id = ? AND id = ?")
      .get(applicationId, id) as DocRow | undefined;
  }

  /** By an already-cleaned name. */
  private rowByName(applicationId: number, name: string): DocRow | undefined {
    return this.db
      .prepare("SELECT * FROM application_documents WHERE application_id = ? AND name = ?")
      .get(applicationId, name) as DocRow | undefined;
  }

  private toNote(row: DocRow | undefined): Note | undefined {
    if (row?.kind !== "note") return undefined;
    return { ...this.toMeta(row), kind: "note", content: row.content ?? "" };
  }

  private storagePath(applicationId: number, name: string): string {
    if (!this.docsDir) {
      throw new ApplicationError("file documents need a data directory (none configured)");
    }
    return this.guard(join(this.docsDir, String(applicationId), ...name.split("/"))) as string;
  }

  /** A stored path, only if it resolves inside docsDir (defense in depth against a tampered row). */
  private guard(path: string): string | undefined {
    if (!this.docsDir) return undefined;
    const root = resolve(this.docsDir);
    const full = resolve(normalize(path));
    const rel = relative(root, full);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..")
      ? full
      : undefined;
  }

  private deleteFile(path: string): void {
    const safe = this.guard(path);
    if (safe) rmSync(safe, { force: true });
  }

  private toMeta(row: DocRow): DocumentMeta {
    return {
      id: row.id,
      applicationId: row.application_id,
      name: row.name,
      kind: row.kind === "file" ? "file" : "note",
      mime: row.mime,
      size: row.size,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

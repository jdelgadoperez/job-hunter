import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { isApplicationStatus } from "./model";
import { ApplicationError } from "./store";

/** Where the standalone `jt` tracker kept its database (honoring its `JOBTRACK_DB` override). */
export function defaultJtDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.JOBTRACK_DB || join(homedir(), ".jobtrack", "jobtrack.db");
}

export type JtImportResult = { imported: number; skipped: number; notes: number };

type JtAppRow = {
  id: number;
  company: string;
  role: string;
  status: string;
  date_applied: string;
  url: string | null;
  source: string | null;
  salary_range: string | null;
  recruiter: string | null;
  archived: number;
  created_at: string | null;
  updated_at: string | null;
};

type JtNoteRow = { date: string; content: string };

/**
 * Copy every application (and its notes) from a `jt` database into job-hunter's. The jt database
 * is opened read-only and never modified. Idempotent: an application whose company + role + date
 * applied already exists is skipped, so re-running the import doesn't duplicate anything.
 */
export function importJtDatabase(target: Database.Database, jtDbPath: string): JtImportResult {
  if (!existsSync(jtDbPath)) throw new ApplicationError(`jt database not found: ${jtDbPath}`);
  const source = new Database(jtDbPath, { readonly: true, fileMustExist: true });
  try {
    let hasTable: unknown;
    try {
      hasTable = source
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'applications'")
        .get();
    } catch {
      // better-sqlite3 opens any file lazily; the first query is where "not a database" surfaces.
      hasTable = undefined;
    }
    if (!hasTable) {
      throw new ApplicationError(`not a jt database (no applications table): ${jtDbPath}`);
    }

    const apps = source.prepare("SELECT * FROM applications ORDER BY id").all() as JtAppRow[];
    const notesFor = source.prepare(
      "SELECT date, content FROM notes WHERE application_id = ? ORDER BY date, id",
    );
    const exists = target.prepare(
      "SELECT 1 FROM applications WHERE lower(company) = lower(?) AND lower(role) = lower(?) AND date_applied = ?",
    );
    const insertApp = target.prepare(
      `INSERT INTO applications
         (company, role, status, date_applied, url, source, salary_range, recruiter, archived,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, coalesce(?, datetime('now')), coalesce(?, datetime('now')))`,
    );
    const insertNote = target.prepare(
      "INSERT INTO application_notes (application_id, date, content) VALUES (?, ?, ?)",
    );

    const result: JtImportResult = { imported: 0, skipped: 0, notes: 0 };
    target.transaction(() => {
      for (const app of apps) {
        if (exists.get(app.company, app.role, app.date_applied)) {
          result.skipped++;
          continue;
        }
        const info = insertApp.run(
          app.company,
          app.role,
          isApplicationStatus(app.status) ? app.status : "applied",
          app.date_applied,
          app.url,
          app.source,
          app.salary_range,
          app.recruiter,
          app.archived ? 1 : 0,
          app.created_at,
          app.updated_at,
        );
        const newId = Number(info.lastInsertRowid);
        for (const note of notesFor.all(app.id) as JtNoteRow[]) {
          insertNote.run(newId, note.date, note.content);
          result.notes++;
        }
        result.imported++;
      }
    })();
    return result;
  } finally {
    source.close();
  }
}

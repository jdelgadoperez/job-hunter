import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ApplicationError, type ApplicationStore } from "./store";

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
 * applied already exists is skipped, so re-running the import doesn't duplicate anything. Each
 * import is its own transaction (via `importRecord`), so a failure keeps what was already copied
 * and a re-run picks up the rest.
 */
export function importJtDatabase(target: ApplicationStore, jtDbPath: string): JtImportResult {
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
    const result: JtImportResult = { imported: 0, skipped: 0, notes: 0 };
    for (const app of apps) {
      if (target.hasMatching(app.company, app.role, app.date_applied)) {
        result.skipped++;
        continue;
      }
      const notes = notesFor.all(app.id) as JtNoteRow[];
      target.importRecord(
        {
          company: app.company,
          role: app.role,
          status: app.status,
          dateApplied: app.date_applied,
          url: app.url,
          source: app.source,
          salaryRange: app.salary_range,
          recruiter: app.recruiter,
          archived: Boolean(app.archived),
          createdAt: app.created_at,
          updatedAt: app.updated_at,
        },
        notes,
      );
      result.imported++;
      result.notes += notes.length;
    }
    return result;
  } finally {
    source.close();
  }
}

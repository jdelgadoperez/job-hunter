import type Database from "better-sqlite3";
import {
  type Application,
  type ApplicationCounts,
  type ApplicationNote,
  type ApplicationPatch,
  type ApplicationStatus,
  CLOSED_STATUSES,
  isApplicationStatus,
  type NewApplication,
} from "./model";

/** Today's local calendar date as YYYY-MM-DD (the user's day, not UTC's). */
export function localToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** A strict, real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export class ApplicationError extends Error {}

/** No application matched a selector or id (as opposed to bad input or an ambiguous match). */
export class ApplicationNotFoundError extends ApplicationError {}

/** The auto note every new application starts with; also how an untouched auto-created one is recognized. */
const APPLIED_NOTE = "Applied";

type ApplicationRow = {
  id: number;
  company: string;
  role: string;
  status: string;
  date_applied: string;
  url: string | null;
  source: string | null;
  salary_range: string | null;
  recruiter: string | null;
  posting_id: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
};

type NoteRow = { id: number; application_id: number; date: string; content: string };

const PATCH_COLUMNS: Record<keyof ApplicationPatch, string> = {
  company: "company",
  role: "role",
  dateApplied: "date_applied",
  url: "url",
  source: "source",
  salaryRange: "salary_range",
  recruiter: "recruiter",
};

function titleCase(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export type ListApplicationsOptions = {
  status?: ApplicationStatus;
  /** Show archived applications instead of active ones. */
  archived?: boolean;
};

/**
 * Application tracking over the shared job-hunter SQLite database. Owned by `Repository`
 * (`repo.applications`), which creates the tables; this class only reads and writes them.
 */
export class ApplicationStore {
  constructor(
    private readonly db: Database.Database,
    private readonly today: () => string = localToday,
    /** Removes an application's documents (rows + stored files) when the application is deleted. */
    private readonly removeDocuments: (applicationId: number) => void = () => {},
  ) {}

  /** Create an application plus its opening "Applied" note. Returns the stored application. */
  add(input: NewApplication): Application {
    const company = input.company.trim();
    const role = input.role.trim();
    if (!company) throw new ApplicationError("company is required");
    if (!role) throw new ApplicationError("role is required");
    const dateApplied = input.dateApplied ?? this.today();
    if (!isIsoDate(dateApplied)) {
      throw new ApplicationError(`invalid date: ${dateApplied} (expected YYYY-MM-DD)`);
    }
    const status = input.status ?? "applied";
    if (!isApplicationStatus(status)) throw new ApplicationError(`invalid status: ${status}`);
    const postingId = trimOrNull(input.postingId);
    if (postingId && this.getByPostingId(postingId)) {
      throw new ApplicationError(`posting ${postingId} already has an application`);
    }

    const insert = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO applications
             (company, role, status, date_applied, url, source, salary_range, recruiter, posting_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          company,
          role,
          status,
          dateApplied,
          trimOrNull(input.url),
          trimOrNull(input.source),
          trimOrNull(input.salaryRange),
          trimOrNull(input.recruiter),
          postingId,
        );
      const id = Number(info.lastInsertRowid);
      this.insertNote(id, APPLIED_NOTE, dateApplied);
      return id;
    });
    return this.require(insert());
  }

  get(id: number): Application | undefined {
    const row = this.db.prepare("SELECT * FROM applications WHERE id = ?").get(id) as
      | ApplicationRow
      | undefined;
    return row ? this.toApplication(row) : undefined;
  }

  getByPostingId(postingId: string): Application | undefined {
    const row = this.db.prepare("SELECT * FROM applications WHERE posting_id = ?").get(postingId) as
      | ApplicationRow
      | undefined;
    return row ? this.toApplication(row) : undefined;
  }

  /** Active (or archived) applications, newest first, optionally filtered by status. */
  list(opts: ListApplicationsOptions = {}): Application[] {
    const params: unknown[] = [opts.archived ? 1 : 0];
    let sql = "SELECT * FROM applications WHERE archived = ?";
    if (opts.status) {
      sql += " AND status = ?";
      params.push(opts.status);
    }
    sql += " ORDER BY date_applied DESC, id DESC";
    return (this.db.prepare(sql).all(...params) as ApplicationRow[]).map((r) =>
      this.toApplication(r),
    );
  }

  /** Case-insensitive search across every text field and note content, archived included. */
  search(term: string): Application[] {
    const pattern = `%${term.trim()}%`;
    const rows = this.db
      .prepare(
        `SELECT DISTINCT a.* FROM applications a
         LEFT JOIN application_notes n ON n.application_id = a.id
         WHERE a.company LIKE ? OR a.role LIKE ? OR a.source LIKE ? OR a.recruiter LIKE ?
            OR a.salary_range LIKE ? OR a.url LIKE ? OR n.content LIKE ?
         ORDER BY a.date_applied DESC, a.id DESC`,
      )
      .all(pattern, pattern, pattern, pattern, pattern, pattern, pattern) as ApplicationRow[];
    return rows.map((r) => this.toApplication(r));
  }

  /**
   * Resolve a CLI-style selector to one application: a numeric id, or a company name. A company
   * name matches case-insensitively as a substring; an exact name wins over partial ones. Throws
   * an `ApplicationError` listing the candidates when the selector is ambiguous or matches nothing.
   */
  resolve(selector: string, opts: { archived?: boolean } = {}): Application {
    const trimmed = selector.trim();
    if (/^\d+$/.test(trimmed)) {
      const byId = this.get(Number(trimmed));
      if (byId) return byId;
    }
    const rows = this.db
      .prepare(
        "SELECT * FROM applications WHERE archived = ? AND company LIKE ? ORDER BY date_applied DESC, id DESC",
      )
      .all(opts.archived ? 1 : 0, `%${trimmed}%`) as ApplicationRow[];
    const exact = rows.filter((r) => r.company.toLowerCase() === trimmed.toLowerCase());
    const candidates = exact.length > 0 ? exact : rows;
    const [only] = candidates;
    if (candidates.length === 1 && only) return this.toApplication(only);
    if (candidates.length === 0) {
      throw new ApplicationNotFoundError(
        `no ${opts.archived ? "archived " : ""}application matches "${trimmed}"`,
      );
    }
    const listing = candidates.map((r) => `  ${r.id}: ${r.company} | ${r.role}`).join("\n");
    throw new ApplicationError(
      `"${trimmed}" matches ${candidates.length} applications; use the id:\n${listing}`,
    );
  }

  /** Update descriptive fields. Unknown keys are ignored; returns the updated application. */
  update(id: number, patch: ApplicationPatch): Application {
    this.require(id);
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(PATCH_COLUMNS) as [
      keyof ApplicationPatch,
      string,
    ][]) {
      if (!(key in patch) || patch[key] === undefined) continue;
      let value: string | null;
      if (key === "company" || key === "role") {
        value = (patch[key] ?? "").trim();
        if (!value) throw new ApplicationError(`${key} cannot be empty`);
      } else if (key === "dateApplied") {
        value = patch.dateApplied ?? "";
        if (!isIsoDate(value)) {
          throw new ApplicationError(`invalid date: ${value} (expected YYYY-MM-DD)`);
        }
      } else {
        value = trimOrNull(patch[key]);
      }
      sets.push(`${column} = ?`);
      values.push(value);
    }
    if (sets.length > 0) {
      this.db
        .prepare(
          `UPDATE applications SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`,
        )
        .run(...values, id);
    }
    return this.require(id);
  }

  /** Move an application to a new status and record the change as a dated note. */
  setStatus(id: number, status: ApplicationStatus, date: string = this.today()): Application {
    if (!isApplicationStatus(status)) throw new ApplicationError(`invalid status: ${status}`);
    if (!isIsoDate(date)) throw new ApplicationError(`invalid date: ${date} (expected YYYY-MM-DD)`);
    const current = this.require(id);
    if (current.status === status) return current;
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE applications SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(status, id);
      this.insertNote(
        id,
        `Status changed from ${titleCase(current.status)} to ${titleCase(status)}`,
        date,
      );
    })();
    return this.require(id);
  }

  addNote(id: number, content: string, date: string = this.today()): ApplicationNote {
    const text = content.trim();
    if (!text) throw new ApplicationError("note is empty");
    if (!isIsoDate(date)) throw new ApplicationError(`invalid date: ${date} (expected YYYY-MM-DD)`);
    this.require(id);
    const noteId = this.insertNote(id, text, date);
    this.touch(id);
    return { id: noteId, applicationId: id, date, content: text };
  }

  /** Archive a closed application (rejected / ghosted / withdrawn). */
  archive(id: number): Application {
    const app = this.require(id);
    if (!CLOSED_STATUSES.includes(app.status)) {
      throw new ApplicationError(
        `cannot archive a "${app.status}" application; only ${CLOSED_STATUSES.join(", ")} can be archived`,
      );
    }
    this.setArchived(id, true);
    return this.require(id);
  }

  unarchive(id: number): Application {
    this.require(id);
    this.setArchived(id, false);
    return this.require(id);
  }

  /** Closed applications that haven't been archived yet. */
  listArchivable(): Application[] {
    return this.list().filter((a) => CLOSED_STATUSES.includes(a.status));
  }

  /** Delete an application with its notes and documents; returns whether it existed. */
  remove(id: number): boolean {
    return this.db.transaction(() => {
      this.removeDocuments(id);
      this.db.prepare("DELETE FROM application_notes WHERE application_id = ?").run(id);
      return this.db.prepare("DELETE FROM applications WHERE id = ?").run(id).changes > 0;
    })();
  }

  countsByStatus(opts: { archived?: boolean } = {}): ApplicationCounts {
    const rows = this.db
      .prepare("SELECT status, count(*) AS n FROM applications WHERE archived = ? GROUP BY status")
      .all(opts.archived ? 1 : 0) as { status: string; n: number }[];
    const counts: ApplicationCounts = {};
    for (const row of rows) if (isApplicationStatus(row.status)) counts[row.status] = row.n;
    return counts;
  }

  /**
   * Ensure the posting has an application, creating one from the stored posting when it doesn't.
   * Called when a match is marked applied. Returns undefined if the posting isn't in the database.
   */
  ensureForPosting(postingId: string, dateApplied?: string): Application | undefined {
    const existing = this.getByPostingId(postingId);
    if (existing) return existing;
    const posting = this.db
      .prepare("SELECT company, title, url, source FROM postings WHERE id = ?")
      .get(postingId) as
      | { company: string; title: string; url: string; source: string }
      | undefined;
    if (!posting) return undefined;
    return this.add({
      company: posting.company,
      role: posting.title,
      url: posting.url,
      source: posting.source,
      postingId,
      ...(dateApplied && isIsoDate(dateApplied) ? { dateApplied } : {}),
    });
  }

  /**
   * Open an application for every match marked applied that doesn't have one — matches marked
   * applied before application tracking existed. Dated from when the match was marked. Idempotent
   * (cheap no-op once caught up), so it runs on every startup. Returns how many were created.
   */
  backfillFromAppliedMatches(): number {
    const rows = this.db
      .prepare(
        `SELECT ua.posting_id, substr(ua.updated_at, 1, 10) AS day FROM user_actions ua
         LEFT JOIN applications a ON a.posting_id = ua.posting_id
         WHERE ua.action = 'applied' AND a.id IS NULL`,
      )
      .all() as { posting_id: string; day: string }[];
    let created = 0;
    this.db.transaction(() => {
      for (const row of rows) if (this.ensureForPosting(row.posting_id, row.day)) created++;
    })();
    return created;
  }

  /**
   * Undo `ensureForPosting` when a match is un-marked applied — but only while the application is
   * untouched (still "applied", not archived, no notes beyond the opening one, no documents).
   * Anything the user has invested in is kept and merely unlinked from the posting. Returns whether
   * it was deleted.
   */
  releasePosting(postingId: string): boolean {
    const app = this.getByPostingId(postingId);
    if (!app) return false;
    const hasDocuments = this.db
      .prepare("SELECT 1 FROM application_documents WHERE application_id = ? LIMIT 1")
      .get(app.id);
    const untouched =
      app.status === "applied" &&
      !app.archived &&
      !hasDocuments &&
      app.notes.length <= 1 &&
      app.notes.every((n) => n.content === APPLIED_NOTE);
    if (untouched) return this.remove(app.id);
    this.db.prepare("UPDATE applications SET posting_id = NULL WHERE id = ?").run(app.id);
    return false;
  }

  private setArchived(id: number, archived: boolean): void {
    this.db
      .prepare("UPDATE applications SET archived = ?, updated_at = datetime('now') WHERE id = ?")
      .run(archived ? 1 : 0, id);
  }

  private touch(id: number): void {
    this.db.prepare("UPDATE applications SET updated_at = datetime('now') WHERE id = ?").run(id);
  }

  private insertNote(applicationId: number, content: string, date: string): number {
    const info = this.db
      .prepare("INSERT INTO application_notes (application_id, date, content) VALUES (?, ?, ?)")
      .run(applicationId, date, content);
    return Number(info.lastInsertRowid);
  }

  private require(id: number): Application {
    const app = this.get(id);
    if (!app) throw new ApplicationNotFoundError(`no application with id ${id}`);
    return app;
  }

  private notesFor(applicationId: number): ApplicationNote[] {
    const rows = this.db
      .prepare("SELECT * FROM application_notes WHERE application_id = ? ORDER BY date, id")
      .all(applicationId) as NoteRow[];
    return rows.map((r) => ({
      id: r.id,
      applicationId: r.application_id,
      date: r.date,
      content: r.content,
    }));
  }

  private toApplication(row: ApplicationRow): Application {
    return {
      id: row.id,
      company: row.company,
      role: row.role,
      status: isApplicationStatus(row.status) ? row.status : "applied",
      dateApplied: row.date_applied,
      url: row.url,
      source: row.source,
      salaryRange: row.salary_range,
      recruiter: row.recruiter,
      postingId: row.posting_id,
      archived: row.archived === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      notes: this.notesFor(row.id),
    };
  }
}

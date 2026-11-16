import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "@app/storage/repository";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultJtDbPath, importJtDatabase } from "./import-jt";

/** The jt schema verbatim (job-hunt's src/jobtrack/db.py SCHEMA_SQL). */
const JT_SCHEMA = `
CREATE TABLE applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, company TEXT NOT NULL, role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'applied', date_applied TEXT NOT NULL, url TEXT, source TEXT,
  salary_range TEXT, recruiter TEXT, archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, application_id INTEGER NOT NULL REFERENCES applications(id),
  date TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

let dir: string;
let repo: Repository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jt-import-"));
  repo = new Repository(":memory:");
});
afterEach(() => {
  repo.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeJtDb(): string {
  const path = join(dir, "jobtrack.db");
  const db = new Database(path);
  db.exec(JT_SCHEMA);
  db.prepare(
    `INSERT INTO applications (company, role, status, date_applied, url, salary_range, recruiter, archived, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "Solace",
    "Staff Eng",
    "interviewed",
    "2026-04-01",
    "https://s",
    "250k",
    "Kim",
    0,
    "2026-04-01 10:00:00",
  );
  db.prepare(
    "INSERT INTO applications (company, role, status, date_applied, archived) VALUES (?, ?, ?, ?, ?)",
  ).run("Inspiren", "Lead", "rejected", "2026-03-01", 1);
  db.prepare(
    "INSERT INTO applications (company, role, status, date_applied) VALUES (?, ?, ?, ?)",
  ).run("Weird", "Role", "mystery", "2026-02-01");
  db.prepare("INSERT INTO notes (application_id, date, content) VALUES (?, ?, ?)").run(
    1,
    "2026-04-01",
    "Applied",
  );
  db.prepare("INSERT INTO notes (application_id, date, content) VALUES (?, ?, ?)").run(
    1,
    "2026-04-10",
    "Onsite",
  );
  db.close();
  return path;
}

describe("importJtDatabase", () => {
  it("copies applications and notes, preserving status, archive flag, and timestamps", () => {
    const result = importJtDatabase(repo.applications, makeJtDb());
    expect(result).toEqual({ imported: 3, skipped: 0, notes: 2 });

    const solace = repo.applications.resolve("solace");
    expect(solace).toMatchObject({
      role: "Staff Eng",
      status: "interviewed",
      dateApplied: "2026-04-01",
      url: "https://s",
      salaryRange: "250k",
      recruiter: "Kim",
      createdAt: "2026-04-01 10:00:00",
    });
    expect(solace.notes.map((n) => n.content)).toEqual(["Applied", "Onsite"]);
    expect(repo.applications.list({ archived: true }).map((a) => a.company)).toEqual(["Inspiren"]);
    // An unrecognized status falls back to "applied" rather than failing the import.
    expect(repo.applications.resolve("weird").status).toBe("applied");
  });

  it("is idempotent", () => {
    const path = makeJtDb();
    importJtDatabase(repo.applications, path);
    expect(importJtDatabase(repo.applications, path)).toEqual({
      imported: 0,
      skipped: 3,
      notes: 0,
    });
    expect(repo.applications.search("")).toHaveLength(3);
  });

  it("explains a missing file or a non-jt database", () => {
    expect(() => importJtDatabase(repo.applications, join(dir, "missing.db"))).toThrow(
      "jt database not found",
    );
    const other = join(dir, "other.db");
    new Database(other).exec("CREATE TABLE x (y)");
    expect(() => importJtDatabase(repo.applications, other)).toThrow("not a jt database");
    const junk = join(dir, "junk.db");
    writeFileSync(junk, "this is not sqlite at all, just some text padding it out a bit");
    expect(() => importJtDatabase(repo.applications, junk)).toThrow("not a jt database");
  });

  it("defaults to jt's own path and honors JOBTRACK_DB", () => {
    expect(defaultJtDbPath({ JOBTRACK_DB: "/x/jt.db" })).toBe("/x/jt.db");
    expect(defaultJtDbPath({})).toMatch(/\.jobtrack[/\\]jobtrack\.db$/);
  });
});

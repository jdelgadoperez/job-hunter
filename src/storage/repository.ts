import type { JobPosting, MatchResult, SkillProfile } from "@app/domain/types";
import Database from "better-sqlite3";
import { SCHEMA } from "./schema";

export class Repository {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  saveProfile(profile: SkillProfile): number {
    const statement = this.db.prepare("INSERT INTO profiles (data) VALUES (?)");
    const info = statement.run(JSON.stringify(profile));
    return Number(info.lastInsertRowid);
  }

  /** The most recently saved profile, or undefined if none has been built yet. */
  getLatestProfile(): SkillProfile | undefined {
    const row = this.db.prepare("SELECT data FROM profiles ORDER BY id DESC LIMIT 1").get() as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as SkillProfile) : undefined;
  }

  savePosting(posting: JobPosting): void {
    this.db
      .prepare(
        `INSERT INTO postings (id, company, title, url, source, description, location, posted_at, fetched_at)
         VALUES (@id, @company, @title, @url, @source, @description, @location, @postedAt, @fetchedAt)
         ON CONFLICT(id) DO UPDATE SET
           company = excluded.company,
           title = excluded.title,
           url = excluded.url,
           source = excluded.source,
           description = excluded.description,
           location = excluded.location,
           posted_at = excluded.posted_at,
           fetched_at = excluded.fetched_at`,
      )
      .run({
        id: posting.id,
        company: posting.company,
        title: posting.title,
        url: posting.url,
        source: posting.source,
        description: posting.description,
        location: posting.location ?? null,
        postedAt: posting.postedAt?.toISOString() ?? null,
        fetchedAt: posting.fetchedAt.toISOString(),
      });
  }

  saveMatchResult(postingId: string, result: MatchResult): void {
    this.db
      .prepare(
        `INSERT INTO match_results (posting_id, score, matched_skills, missing_skills, rationale)
         VALUES (@postingId, @score, @matched, @missing, @rationale)
         ON CONFLICT(posting_id) DO UPDATE SET
           score = excluded.score,
           matched_skills = excluded.matched_skills,
           missing_skills = excluded.missing_skills,
           rationale = excluded.rationale`,
      )
      .run({
        postingId,
        score: result.score,
        matched: JSON.stringify(result.matchedSkills),
        missing: JSON.stringify(result.missingSkills),
        rationale: result.rationale ?? null,
      });
  }

  /** Scored postings (joined with their match result), highest score first. */
  listScoredPostings(minScore = 0): { posting: JobPosting; result: MatchResult }[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.company, p.title, p.url, p.source, p.description, p.location,
                p.posted_at, p.fetched_at,
                m.score, m.matched_skills, m.missing_skills, m.rationale
         FROM match_results m
         JOIN postings p ON p.id = m.posting_id
         WHERE m.score >= ?
         ORDER BY m.score DESC, p.title`,
      )
      .all(minScore) as {
      id: string;
      company: string;
      title: string;
      url: string;
      source: string;
      description: string;
      location: string | null;
      posted_at: string | null;
      fetched_at: string;
      score: number;
      matched_skills: string;
      missing_skills: string;
      rationale: string | null;
    }[];

    return rows.map((row) => ({
      posting: {
        id: row.id,
        company: row.company,
        title: row.title,
        url: row.url,
        source: row.source,
        description: row.description,
        ...(row.location ? { location: row.location } : {}),
        ...(row.posted_at ? { postedAt: new Date(row.posted_at) } : {}),
        fetchedAt: new Date(row.fetched_at),
      },
      result: {
        score: row.score,
        matchedSkills: JSON.parse(row.matched_skills) as string[],
        missingSkills: JSON.parse(row.missing_skills) as string[],
        ...(row.rationale ? { rationale: row.rationale } : {}),
      },
    }));
  }

  setUserAction(postingId: string, action: "saved" | "dismissed"): void {
    this.db
      .prepare(
        `INSERT INTO user_actions (posting_id, action)
         VALUES (?, ?)
         ON CONFLICT(posting_id) DO UPDATE SET action = excluded.action, updated_at = datetime('now')`,
      )
      .run(postingId, action);
  }

  /** Idempotent upsert of the seeded skill dictionary; re-seeding never duplicates. */
  seedSkills(skills: { name: string; category: string }[]): void {
    const insert = this.db.prepare(
      `INSERT INTO skills (name, category, source) VALUES (@name, @category, 'open-taxonomy')
       ON CONFLICT(name) DO UPDATE SET category = excluded.category`,
    );
    const insertMany = this.db.transaction((rows: { name: string; category: string }[]) => {
      for (const row of rows) {
        insert.run(row);
      }
    });
    insertMany(skills);
  }

  /** Normalized skill names from the seeded dictionary; empty when unseeded. */
  getSkillDictionary(): string[] {
    const rows = this.db.prepare("SELECT name FROM skills ORDER BY name").all() as {
      name: string;
    }[];
    return rows.map((row) => row.name);
  }

  /** Full dictionary entries (name + category), name-sorted, for the management UI. */
  listSkills(): { name: string; category: string }[] {
    const rows = this.db.prepare("SELECT name, category FROM skills ORDER BY name").all() as {
      name: string;
      category: string | null;
    }[];
    return rows.map((row) => ({ name: row.name, category: row.category ?? "other" }));
  }

  /** Upsert a single dictionary skill (tagged as user-added); updates the category on conflict. */
  addSkill(name: string, category: string): void {
    this.db
      .prepare(
        `INSERT INTO skills (name, category, source) VALUES (?, ?, 'user')
         ON CONFLICT(name) DO UPDATE SET category = excluded.category`,
      )
      .run(name, category);
  }

  /** Remove a dictionary skill by name; returns whether a row was deleted. */
  removeSkill(name: string): boolean {
    return this.db.prepare("DELETE FROM skills WHERE name = ?").run(name).changes > 0;
  }

  /** Upsert a user-tracked company by careers URL; re-adding updates the name. */
  addTrackedCompany(careersUrl: string, name?: string): void {
    this.db
      .prepare(
        `INSERT INTO tracked_companies (careers_url, name) VALUES (?, ?)
         ON CONFLICT(careers_url) DO UPDATE SET name = excluded.name`,
      )
      .run(careersUrl, name ?? null);
  }

  listTrackedCompanies(): { careersUrl: string; name?: string }[] {
    const rows = this.db
      .prepare("SELECT careers_url, name FROM tracked_companies ORDER BY added_at, careers_url")
      .all() as { careers_url: string; name: string | null }[];
    return rows.map((row) => ({
      careersUrl: row.careers_url,
      ...(row.name ? { name: row.name } : {}),
    }));
  }

  /** Remove a tracked company; returns whether a row was deleted. */
  removeTrackedCompany(careersUrl: string): boolean {
    const info = this.db
      .prepare("DELETE FROM tracked_companies WHERE careers_url = ?")
      .run(careersUrl);
    return info.changes > 0;
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}

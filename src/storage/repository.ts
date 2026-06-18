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

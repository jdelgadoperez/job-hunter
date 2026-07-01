import { normalizeCareersUrl, normalizeSkill } from "@app/domain/normalize";
import type { JobPosting, MatchResult, SkillProfile } from "@app/domain/types";
import { resolvePostingRemote } from "@app/matching/remote-filter";
import Database from "better-sqlite3";
import { INDEXES, SCHEMA } from "./schema";

/** A company referenced by its careers-page URL (the directory snapshot + diff unit). */
export type CompanyRef = { careersUrl: string; name?: string };

/** A user's disposition toward a match. */
export type UserAction = "saved" | "dismissed" | "applied";

/** A scored posting plus the user's action and whether it's expired (gone from its board). */
export type ScoredPosting = {
  posting: JobPosting;
  result: MatchResult;
  action: UserAction | null;
  expired: boolean;
};

/** Filters for `listScoredPostings`. By default expired, dismissed, and applied postings are hidden. */
export type ListMatchesOptions = {
  includeExpired?: boolean;
  includeDismissed?: boolean;
  remoteOnly?: boolean;
  country?: string;
  includeApplied?: boolean;
  onlyApplied?: boolean;
};

/**
 * How a stored match score was produced. `heuristic-remote-penalized` marks a heuristic score that
 * already had the remote penalty applied, so a later remote-only run skips it instead of penalizing
 * it again (the penalty is applied exactly once).
 */
export type ScorerTag = "heuristic" | "llm" | "heuristic-remote-penalized";

/** A posting eligible for LLM scoring: its heuristic score plus whether the LLM already scored it. */
export type ScoringCandidate = {
  posting: JobPosting;
  /** The current stored MatchResult for this posting (score + skills + rationale + how it was scored). */
  current: MatchResult;
  heuristicScore: number;
  scorer: ScorerTag;
  alreadyLlmScored: boolean;
};

/** A completed scan's outcome: counts plus the directory delta vs. the previous snapshot. */
export type ScanRecord = {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  postingsSeen: number | null;
  companiesSeen: number | null;
  newCompanies: CompanyRef[];
  removedCompanies: CompanyRef[];
};

/** Map the nullable stored `scorer` string to a known ScorerTag, defaulting unknown/legacy to heuristic. */
function normalizeScorerTag(scorer: string | null): ScorerTag {
  if (scorer === "llm") return "llm";
  if (scorer === "heuristic-remote-penalized") return "heuristic-remote-penalized";
  return "heuristic";
}

export class Repository {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Add columns introduced after a database was first created. `CREATE TABLE IF NOT EXISTS` never
   * alters an existing table, so new `postings` columns need an explicit, idempotent `ALTER` for
   * databases that predate them. Each add is guarded by the table's current columns.
   */
  private migrate(): void {
    const postingColumns = new Set(
      (this.db.prepare("PRAGMA table_info(postings)").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    if (!postingColumns.has("last_seen_scan")) {
      this.db.exec("ALTER TABLE postings ADD COLUMN last_seen_scan INTEGER");
    }
    if (!postingColumns.has("expired_at")) {
      this.db.exec("ALTER TABLE postings ADD COLUMN expired_at TEXT");
    }
    if (!postingColumns.has("remote")) {
      this.db.exec("ALTER TABLE postings ADD COLUMN remote INTEGER");
    }
    if (!postingColumns.has("country")) {
      this.db.exec("ALTER TABLE postings ADD COLUMN country TEXT");
    }

    const matchColumns = new Set(
      (this.db.prepare("PRAGMA table_info(match_results)").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    if (!matchColumns.has("scorer")) {
      this.db.exec("ALTER TABLE match_results ADD COLUMN scorer TEXT");
    }

    // Create indexes now that every referenced column is guaranteed to exist (above + base schema).
    this.db.exec(INDEXES);
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

  /**
   * Upsert a posting. When `scanId` is given, stamp it as last seen by that scan and clear any
   * prior expiry — so a posting that reappears after vanishing is revived rather than left expired.
   */
  savePosting(posting: JobPosting, scanId: number | null = null): void {
    this.db
      .prepare(
        `INSERT INTO postings
           (id, company, title, url, source, description, location, remote, country,
            posted_at, fetched_at, last_seen_scan, expired_at)
         VALUES (@id, @company, @title, @url, @source, @description, @location, @remote, @country,
            @postedAt, @fetchedAt, @scanId, NULL)
         ON CONFLICT(id) DO UPDATE SET
           company = excluded.company,
           title = excluded.title,
           url = excluded.url,
           source = excluded.source,
           description = excluded.description,
           location = excluded.location,
           remote = excluded.remote,
           country = excluded.country,
           posted_at = excluded.posted_at,
           fetched_at = excluded.fetched_at,
           last_seen_scan = COALESCE(excluded.last_seen_scan, postings.last_seen_scan),
           -- Reviving a reappeared posting only when this save belongs to a scan.
           expired_at = CASE WHEN excluded.last_seen_scan IS NULL THEN postings.expired_at ELSE NULL END`,
      )
      .run({
        id: posting.id,
        company: posting.company,
        title: posting.title,
        url: posting.url,
        source: posting.source,
        description: posting.description,
        location: posting.location ?? null,
        remote: posting.remote === undefined ? null : posting.remote ? 1 : 0,
        country: posting.country ?? null,
        postedAt: posting.postedAt?.toISOString() ?? null,
        fetchedAt: posting.fetchedAt.toISOString(),
        scanId,
      });
  }

  saveMatchResult(postingId: string, result: MatchResult, scorer: ScorerTag = "heuristic"): void {
    this.db
      .prepare(
        `INSERT INTO match_results (posting_id, score, matched_skills, missing_skills, rationale, scorer)
         VALUES (@postingId, @score, @matched, @missing, @rationale, @scorer)
         ON CONFLICT(posting_id) DO UPDATE SET
           score = excluded.score,
           matched_skills = excluded.matched_skills,
           missing_skills = excluded.missing_skills,
           rationale = excluded.rationale,
           scorer = excluded.scorer`,
      )
      .run({
        postingId,
        score: result.score,
        matched: JSON.stringify(result.matchedSkills),
        missing: JSON.stringify(result.missingSkills),
        rationale: result.rationale ?? null,
        scorer,
      });
  }

  /**
   * Scored postings (joined with their match result + any saved/dismissed action), highest score
   * first. Postings expired by a later scan are excluded unless `includeExpired`; dismissed ones are
   * excluded unless `includeDismissed`.
   */
  listScoredPostings(minScore = 0, opts: ListMatchesOptions = {}): ScoredPosting[] {
    // A specific country also keeps unknown-country (NULL) postings, so a posting whose location
    // couldn't be parsed is never silently dropped from a filtered view — it stays visible and the
    // UI flags it as unknown. (Mirrors the remote filter's blank=remote "don't drop unknowns" rule.)
    const countrySql =
      opts.country !== undefined ? " AND (p.country = ? COLLATE NOCASE OR p.country IS NULL)" : "";

    // Build positional params as a plain array — no tuple assertion needed.
    // minScore is always first; the country value is appended only when the clause is present.
    const params: (string | number)[] = [minScore];
    if (opts.country !== undefined) params.push(opts.country);

    // Action visibility. onlyApplied is an explicit "show me what I applied to" view and overrides
    // the default hides. Otherwise dismissed and applied are each hidden unless their include flag is
    // set. Every clause keeps the `ua.action IS NULL` guard so a no-action posting always shows.
    let actionSql: string;
    if (opts.onlyApplied) {
      actionSql = " AND ua.action = 'applied'";
    } else {
      const hideDismissed = opts.includeDismissed
        ? ""
        : " AND (ua.action IS NULL OR ua.action != 'dismissed')";
      const hideApplied = opts.includeApplied
        ? ""
        : " AND (ua.action IS NULL OR ua.action != 'applied')";
      actionSql = `${hideDismissed}${hideApplied}`;
    }

    // The "Applied" view answers "what did I apply to?" — that intent spans postings that have since
    // expired (the board closed, but your application stands), so onlyApplied shows expired roles too
    // (MatchCard already marks them with the expired badge). Otherwise expired hides unless asked for.
    const hideExpired = opts.includeExpired || opts.onlyApplied ? "" : " AND p.expired_at IS NULL";

    const rows = this.db
      .prepare(
        `SELECT p.id, p.company, p.title, p.url, p.source, p.description, p.location,
                p.remote, p.country,
                p.posted_at, p.fetched_at, p.expired_at,
                m.score, m.matched_skills, m.missing_skills, m.rationale,
                ua.action
         FROM match_results m
         JOIN postings p ON p.id = m.posting_id
         LEFT JOIN user_actions ua ON ua.posting_id = p.id
         WHERE m.score >= ?${hideExpired}${actionSql}${countrySql}
         ORDER BY m.score DESC, p.title`,
      )
      .all(...params) as {
      id: string;
      company: string;
      title: string;
      url: string;
      source: string;
      description: string;
      location: string | null;
      remote: number | null;
      country: string | null;
      posted_at: string | null;
      fetched_at: string;
      expired_at: string | null;
      score: number;
      matched_skills: string;
      missing_skills: string;
      rationale: string | null;
      action: UserAction | null;
    }[];

    // Resolve "remote" once per row (structured flag wins, else the location regex) and reuse the
    // value for both the remoteOnly filter and the on-the-wire value. The filter runs in JS, not SQL,
    // because resolvePostingRemote's fallback semantics can't be expressed faithfully in SQL.
    const resolved = rows.map((row) => ({
      row,
      remote: resolvePostingRemote({
        remote: row.remote == null ? undefined : row.remote === 1,
        location: row.location ?? undefined,
      }),
    }));
    const filtered = opts.remoteOnly ? resolved.filter((r) => r.remote) : resolved;

    return filtered.map(({ row, remote }) => ({
      posting: {
        id: row.id,
        company: row.company,
        title: row.title,
        url: row.url,
        source: row.source,
        description: row.description,
        ...(row.location ? { location: row.location } : {}),
        // Resolved remote on the wire — the client always receives a definitive boolean; the stored
        // column stays raw.
        remote,
        ...(row.country ? { country: row.country } : {}),
        ...(row.posted_at ? { postedAt: new Date(row.posted_at) } : {}),
        fetchedAt: new Date(row.fetched_at),
      },
      result: {
        score: row.score,
        matchedSkills: JSON.parse(row.matched_skills) as string[],
        missingSkills: JSON.parse(row.missing_skills) as string[],
        ...(row.rationale ? { rationale: row.rationale } : {}),
      },
      action: row.action,
      expired: row.expired_at !== null,
    }));
  }

  /** Record a saved/dismissed action for a posting (one per posting; re-setting replaces it). */
  setUserAction(postingId: string, action: UserAction): void {
    this.db
      .prepare(
        `INSERT INTO user_actions (posting_id, action)
         VALUES (?, ?)
         ON CONFLICT(posting_id) DO UPDATE SET action = excluded.action, updated_at = datetime('now')`,
      )
      .run(postingId, action);
  }

  /** Clear any saved/dismissed action for a posting; returns whether one was removed. */
  clearUserAction(postingId: string): boolean {
    return (
      this.db.prepare("DELETE FROM user_actions WHERE posting_id = ?").run(postingId).changes > 0
    );
  }

  /**
   * Idempotent upsert of the seeded skill dictionary; re-seeding never duplicates. Names are
   * normalized (see `normalizeSkill`) so casing variants update one row instead of the `PRIMARY KEY`
   * admitting a near-duplicate.
   */
  seedSkills(skills: { name: string; category: string }[]): void {
    const insert = this.db.prepare(
      `INSERT INTO skills (name, category, source) VALUES (@name, @category, 'open-taxonomy')
       ON CONFLICT(name) DO UPDATE SET category = excluded.category`,
    );
    const insertMany = this.db.transaction((rows: { name: string; category: string }[]) => {
      for (const row of rows) {
        insert.run({ name: normalizeSkill(row.name), category: row.category });
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

  /**
   * Upsert a single dictionary skill (tagged as user-added); updates the category on conflict. The
   * name is normalized (see `normalizeSkill`) so casing variants update the existing row instead of
   * the `PRIMARY KEY` admitting a near-duplicate.
   */
  addSkill(name: string, category: string): void {
    this.db
      .prepare(
        `INSERT INTO skills (name, category, source) VALUES (?, ?, 'user')
         ON CONFLICT(name) DO UPDATE SET category = excluded.category`,
      )
      .run(normalizeSkill(name), category);
  }

  /** Remove a dictionary skill by name; returns whether a row was deleted. */
  removeSkill(name: string): boolean {
    return (
      this.db.prepare("DELETE FROM skills WHERE name = ?").run(normalizeSkill(name)).changes > 0
    );
  }

  /**
   * Upsert a user-tracked company by careers URL; re-adding updates the name. The URL is stored
   * normalized (see `normalizeCareersUrl`) so case/trailing-slash/query-string variants of the same
   * URL update the existing row instead of the `PRIMARY KEY` silently admitting a near-duplicate.
   */
  addTrackedCompany(careersUrl: string, name?: string): void {
    this.db
      .prepare(
        `INSERT INTO tracked_companies (careers_url, name) VALUES (?, ?)
         ON CONFLICT(careers_url) DO UPDATE SET name = excluded.name`,
      )
      .run(normalizeCareersUrl(careersUrl), name ?? null);
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
      .run(normalizeCareersUrl(careersUrl));
    return info.changes > 0;
  }

  /**
   * The most recent directory snapshot's companies (those seen in the latest scan that recorded the
   * directory). Used to surface companies that can't be auto-scanned for manual review.
   */
  listDirectoryCompanies(): CompanyRef[] {
    const rows = this.db
      .prepare(
        `SELECT careers_url, name FROM companies
         WHERE last_seen_scan = (SELECT MAX(last_seen_scan) FROM companies)
         ORDER BY name, careers_url`,
      )
      .all() as { careers_url: string; name: string | null }[];
    return rows.map((row) => ({
      careersUrl: row.careers_url,
      ...(row.name ? { name: row.name } : {}),
    }));
  }

  /** Open a new scan run and return its sequential id (drives the diff + posting expiry). */
  startScan(): number {
    const info = this.db.prepare("INSERT INTO scans (started_at) VALUES (datetime('now'))").run();
    return Number(info.lastInsertRowid);
  }

  /**
   * Snapshot the directory for this scan and diff it against the previous snapshot: returns the
   * companies that appeared and disappeared. The first scan establishes a baseline (empty diff).
   */
  recordDirectory(
    scanId: number,
    companiesIn: CompanyRef[],
  ): { newCompanies: CompanyRef[]; removedCompanies: CompanyRef[] } {
    // Normalized so case/trailing-slash/query-string variants of the same URL update one row
    // instead of the `PRIMARY KEY` admitting a near-duplicate (see `normalizeCareersUrl`).
    const companies = companiesIn.map((c) => ({
      ...c,
      careersUrl: normalizeCareersUrl(c.careersUrl),
    }));
    const existing = this.db
      .prepare("SELECT careers_url, name, last_seen_scan FROM companies")
      .all() as { careers_url: string; name: string | null; last_seen_scan: number }[];
    const existingUrls = new Set(existing.map((e) => e.careers_url));
    const currentUrls = new Set(companies.map((c) => c.careersUrl));
    // The previous scan run, from the scans table — so "removed" means dropped *this* scan only
    // (a company gone several scans ago has an older last_seen_scan and isn't re-reported).
    const prevRow = this.db.prepare("SELECT MAX(id) AS id FROM scans WHERE id < ?").get(scanId) as {
      id: number | null;
    };
    const prevScan = prevRow.id;
    const isBaseline = existing.length === 0;

    const newCompanies = isBaseline ? [] : companies.filter((c) => !existingUrls.has(c.careersUrl));
    const removedCompanies =
      isBaseline || prevScan === null
        ? []
        : existing
            .filter((e) => e.last_seen_scan === prevScan && !currentUrls.has(e.careers_url))
            .map((e) => ({ careersUrl: e.careers_url, ...(e.name ? { name: e.name } : {}) }));

    const upsert = this.db.prepare(
      `INSERT INTO companies (careers_url, name, first_seen_scan, last_seen_scan, last_seen_at)
       VALUES (@url, @name, @scanId, @scanId, datetime('now'))
       ON CONFLICT(careers_url) DO UPDATE SET
         name = excluded.name,
         last_seen_scan = excluded.last_seen_scan,
         last_seen_at = excluded.last_seen_at`,
    );
    const upsertMany = this.db.transaction((rows: CompanyRef[]) => {
      for (const c of rows) upsert.run({ url: c.careersUrl, name: c.name ?? null, scanId });
    });
    upsertMany(companies);

    return { newCompanies, removedCompanies };
  }

  /**
   * Mark postings not seen for `staleAfter` consecutive scans as expired (they vanished from their
   * board). Postings never stamped by a scan (legacy rows) are left alone. Returns how many expired.
   */
  expireStalePostings(currentScanId: number, staleAfter = 2): number {
    return this.db
      .prepare(
        `UPDATE postings SET expired_at = datetime('now')
         WHERE expired_at IS NULL AND last_seen_scan IS NOT NULL
           AND (? - last_seen_scan) >= ?`,
      )
      .run(currentScanId, staleAfter).changes;
  }

  /**
   * Non-expired postings that were NOT seen in the given scan — candidates for a precise liveness
   * re-check (their company may have dropped from the directory, or the role may be gone from a
   * board that was scanned). Returns full `JobPosting`s so the re-check can re-fetch each source.
   */
  listLivePostingsNotSeen(scanId: number): JobPosting[] {
    const rows = this.db
      .prepare(
        `SELECT id, company, title, url, source, description, location, posted_at, fetched_at
         FROM postings
         WHERE expired_at IS NULL AND (last_seen_scan IS NULL OR last_seen_scan != ?)`,
      )
      .all(scanId) as {
      id: string;
      company: string;
      title: string;
      url: string;
      source: string;
      description: string;
      location: string | null;
      posted_at: string | null;
      fetched_at: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      company: row.company,
      title: row.title,
      url: row.url,
      source: row.source,
      description: row.description,
      ...(row.location ? { location: row.location } : {}),
      ...(row.posted_at ? { postedAt: new Date(row.posted_at) } : {}),
      fetchedAt: new Date(row.fetched_at),
    }));
  }

  /** Mark a single posting expired (idempotent); returns whether it newly expired. */
  markPostingExpired(postingId: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE postings SET expired_at = datetime('now') WHERE id = ? AND expired_at IS NULL",
        )
        .run(postingId).changes > 0
    );
  }

  /**
   * Non-expired postings whose heuristic score meets `minHeuristic`, ranked score-desc then title,
   * each tagged with whether its match row was written by the LLM. Drives the `score` command's
   * candidate gating; expired postings are never re-scored.
   */
  listPostingsForScoring(opts: { minHeuristic: number }): ScoringCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.company, p.title, p.url, p.source, p.description, p.location,
                p.remote, p.country, p.posted_at, p.fetched_at,
                m.score, m.matched_skills, m.missing_skills, m.rationale, m.scorer
         FROM match_results m
         JOIN postings p ON p.id = m.posting_id
         WHERE p.expired_at IS NULL AND m.score >= ?
         ORDER BY m.score DESC, p.title`,
      )
      .all(opts.minHeuristic) as {
      id: string;
      company: string;
      title: string;
      url: string;
      source: string;
      description: string;
      location: string | null;
      remote: number | null;
      country: string | null;
      posted_at: string | null;
      fetched_at: string;
      score: number;
      matched_skills: string;
      missing_skills: string;
      rationale: string | null;
      scorer: string | null;
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
        // Carry the structured remote flag so resolvePostingRemote in score-run honors it (the
        // flag wins over the location regex); omit when NULL so unknown stays undefined.
        ...(row.remote == null ? {} : { remote: row.remote === 1 }),
        ...(row.country ? { country: row.country } : {}),
        ...(row.posted_at ? { postedAt: new Date(row.posted_at) } : {}),
        fetchedAt: new Date(row.fetched_at),
      },
      current: {
        score: row.score,
        matchedSkills: JSON.parse(row.matched_skills) as string[],
        missingSkills: JSON.parse(row.missing_skills) as string[],
        ...(row.rationale ? { rationale: row.rationale } : {}),
      },
      heuristicScore: row.score,
      scorer: normalizeScorerTag(row.scorer),
      alreadyLlmScored: row.scorer === "llm",
    }));
  }

  /** Count of non-expired postings — the dry-run's "In DB" total before any filtering. */
  countLivePostings(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM postings WHERE expired_at IS NULL")
      .get() as { n: number };
    return row.n;
  }

  /** Record the outcome (counts + directory diff) of a finished scan. */
  finishScan(
    scanId: number,
    summary: {
      postingsSeen: number;
      companiesSeen: number;
      newCompanies: CompanyRef[];
      removedCompanies: CompanyRef[];
    },
  ): void {
    this.db
      .prepare(
        `UPDATE scans SET finished_at = datetime('now'), postings_seen = @postings,
           companies_seen = @companies, new_companies = @new, removed_companies = @removed
         WHERE id = @id`,
      )
      .run({
        id: scanId,
        postings: summary.postingsSeen,
        companies: summary.companiesSeen,
        new: JSON.stringify(summary.newCompanies),
        removed: JSON.stringify(summary.removedCompanies),
      });
  }

  /** The most recently completed scan (counts + directory diff), or undefined if none finished. */
  getLatestScan(): ScanRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM scans WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get() as
      | {
          id: number;
          started_at: string;
          finished_at: string;
          postings_seen: number | null;
          companies_seen: number | null;
          new_companies: string | null;
          removed_companies: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      postingsSeen: row.postings_seen,
      companiesSeen: row.companies_seen,
      newCompanies: row.new_companies ? (JSON.parse(row.new_companies) as CompanyRef[]) : [],
      removedCompanies: row.removed_companies
        ? (JSON.parse(row.removed_companies) as CompanyRef[])
        : [],
    };
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

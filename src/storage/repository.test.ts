import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobPosting, MatchResult, SkillProfile } from "@app/domain/types";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { Repository } from "./repository";

function newRepo(): Repository {
  return new Repository(":memory:");
}

const profile: SkillProfile = {
  skills: ["typescript"],
  roleKeywords: ["frontend engineer"],
  categories: ["Engineering"],
  yearsExperience: 15,
};

const posting: JobPosting = {
  id: "abc",
  company: "Acme",
  title: "Engineer",
  url: "https://example.com/abc",
  source: "greenhouse",
  description: "TypeScript role",
  fetchedAt: new Date("2026-06-17T00:00:00Z"),
};

describe("Repository", () => {
  it("round-trips a setting", () => {
    const repo = newRepo();
    repo.setSetting("apiKey", "secret-value");
    expect(repo.getSetting("apiKey")).toBe("secret-value");
    repo.close();
  });

  it("returns the latest profile and scored postings ordered by score", () => {
    const repo = newRepo();
    expect(repo.getLatestProfile()).toBeUndefined();
    repo.saveProfile(profile);
    repo.saveProfile({ ...profile, skills: ["typescript", "go"] });
    expect(repo.getLatestProfile()?.skills).toEqual(["typescript", "go"]);

    repo.savePosting(posting);
    repo.savePosting({ ...posting, id: "def", title: "Other" });
    repo.saveMatchResult("abc", { score: 90, matchedSkills: ["typescript"], missingSkills: [] });
    repo.saveMatchResult("def", { score: 40, matchedSkills: [], missingSkills: ["go"] });

    const all = repo.listScoredPostings();
    expect(all.map((s) => s.result.score)).toEqual([90, 40]);
    expect(all[0]?.posting.fetchedAt).toBeInstanceOf(Date);
    expect(repo.listScoredPostings(50).map((s) => s.posting.id)).toEqual(["abc"]);
    repo.close();
  });

  it("adds, lists, and removes tracked companies without duplicating", () => {
    const repo = newRepo();
    repo.addTrackedCompany("https://acme.com/careers", "Acme");
    repo.addTrackedCompany("https://globex.com/jobs");
    // Re-adding the same URL updates the name rather than duplicating.
    repo.addTrackedCompany("https://acme.com/careers", "Acme Inc");

    const tracked = repo.listTrackedCompanies();
    expect(tracked).toEqual([
      { careersUrl: "https://acme.com/careers", name: "Acme Inc" },
      { careersUrl: "https://globex.com/jobs" },
    ]);

    expect(repo.removeTrackedCompany("https://acme.com/careers")).toBe(true);
    expect(repo.removeTrackedCompany("https://acme.com/careers")).toBe(false);
    expect(repo.listTrackedCompanies()).toEqual([{ careersUrl: "https://globex.com/jobs" }]);
    repo.close();
  });

  it("returns undefined for a missing setting", () => {
    const repo = newRepo();
    expect(repo.getSetting("missing")).toBeUndefined();
    repo.close();
  });

  it("overwrites a setting on repeated set", () => {
    const repo = newRepo();
    repo.setSetting("apiKey", "first");
    repo.setSetting("apiKey", "second");
    expect(repo.getSetting("apiKey")).toBe("second");
    repo.close();
  });

  it("saves a profile and returns a positive row id", () => {
    const repo = newRepo();
    const id = repo.saveProfile(profile);
    expect(id).toBeGreaterThan(0);
    repo.close();
  });

  it("saves a posting and an idempotent user action without throwing", () => {
    const repo = newRepo();
    repo.savePosting(posting);
    repo.setUserAction(posting.id, "saved");
    repo.setUserAction(posting.id, "dismissed");
    repo.close();
  });

  it("saves a match result for a stored posting", () => {
    const repo = newRepo();
    repo.savePosting(posting);
    const result: MatchResult = {
      score: 50,
      matchedSkills: ["typescript"],
      missingSkills: ["go"],
    };
    expect(() => repo.saveMatchResult(posting.id, result)).not.toThrow();
    repo.close();
  });
});

function postingWith(id: string): JobPosting {
  return { ...posting, id, url: `https://example.com/${id}` };
}

describe("incremental scans — directory diff", () => {
  it("treats the first scan as a baseline (no diff), then reports new/removed", () => {
    const repo = newRepo();

    const s1 = repo.startScan();
    const baseline = repo.recordDirectory(s1, [
      { careersUrl: "https://a.com", name: "A" },
      { careersUrl: "https://b.com", name: "B" },
    ]);
    expect(baseline).toEqual({ newCompanies: [], removedCompanies: [] });

    const s2 = repo.startScan();
    const diff = repo.recordDirectory(s2, [
      { careersUrl: "https://a.com", name: "A" },
      { careersUrl: "https://c.com", name: "C" },
    ]);
    expect(diff.newCompanies).toEqual([{ careersUrl: "https://c.com", name: "C" }]);
    expect(diff.removedCompanies).toEqual([{ careersUrl: "https://b.com", name: "B" }]);

    repo.finishScan(s2, {
      postingsSeen: 0,
      companiesSeen: 2,
      newCompanies: diff.newCompanies,
      removedCompanies: diff.removedCompanies,
    });
    const latest = repo.getLatestScan();
    expect(latest?.id).toBe(s2);
    expect(latest?.removedCompanies).toEqual([{ careersUrl: "https://b.com", name: "B" }]);
    repo.close();
  });

  it("does not re-report a company removed in an earlier scan", () => {
    const repo = newRepo();
    repo.recordDirectory(repo.startScan(), [{ careersUrl: "https://b.com" }]); // baseline
    const drop = repo.recordDirectory(repo.startScan(), []); // b removed here
    expect(drop.removedCompanies).toEqual([{ careersUrl: "https://b.com" }]);
    const after = repo.recordDirectory(repo.startScan(), []); // already gone — silent
    expect(after.removedCompanies).toEqual([]);
    repo.close();
  });

  it("listDirectoryCompanies returns the most recent snapshot's companies", () => {
    const repo = newRepo();
    repo.recordDirectory(repo.startScan(), [
      { careersUrl: "https://a.com", name: "A" },
      { careersUrl: "https://b.com", name: "B" },
    ]);
    // A later scan no longer lists B — it should drop out of the current snapshot.
    repo.recordDirectory(repo.startScan(), [{ careersUrl: "https://a.com", name: "A" }]);
    expect(repo.listDirectoryCompanies()).toEqual([{ careersUrl: "https://a.com", name: "A" }]);
    repo.close();
  });
});

describe("incremental scans — posting expiry", () => {
  function seedScored(repo: Repository, id: string, scanId: number): void {
    repo.savePosting(postingWith(id), scanId);
    repo.saveMatchResult(id, { score: 80, matchedSkills: [], missingSkills: [] });
  }

  it("expires a posting after it misses two consecutive scans, and revives it on return", () => {
    const repo = newRepo();
    const s1 = repo.startScan();
    seedScored(repo, "p1", s1);

    // One missed scan: still listed.
    expect(repo.expireStalePostings(repo.startScan())).toBe(0);
    expect(repo.listScoredPostings(0)).toHaveLength(1);

    // Second consecutive miss: expired and dropped from the default list.
    const expired = repo.expireStalePostings(repo.startScan());
    expect(expired).toBe(1);
    expect(repo.listScoredPostings(0)).toHaveLength(0);
    expect(repo.listScoredPostings(0, { includeExpired: true })).toHaveLength(1);

    // Seen again in a later scan: revived.
    seedScored(repo, "p1", repo.startScan());
    expect(repo.listScoredPostings(0)).toHaveLength(1);
    repo.close();
  });

  it("never expires legacy postings saved without a scan id", () => {
    const repo = newRepo();
    repo.savePosting(postingWith("legacy")); // no scanId
    repo.saveMatchResult("legacy", { score: 90, matchedSkills: [], missingSkills: [] });
    expect(repo.expireStalePostings(99)).toBe(0);
    expect(repo.listScoredPostings(0)).toHaveLength(1);
    repo.close();
  });
});

describe("match actions — save / dismiss", () => {
  function seed(repo: Repository, id: string): void {
    repo.savePosting(postingWith(id));
    repo.saveMatchResult(id, { score: 80, matchedSkills: [], missingSkills: [] });
  }

  it("defaults action to null and reflects a saved action", () => {
    const repo = newRepo();
    seed(repo, "p1");
    expect(repo.listScoredPostings(0)[0]?.action).toBeNull();

    repo.setUserAction("p1", "saved");
    const row = repo.listScoredPostings(0)[0];
    expect(row?.action).toBe("saved");
    expect(row?.expired).toBe(false);
    repo.close();
  });

  it("hides dismissed matches unless includeDismissed is set", () => {
    const repo = newRepo();
    seed(repo, "p1");
    repo.setUserAction("p1", "dismissed");

    expect(repo.listScoredPostings(0)).toHaveLength(0);
    const withDismissed = repo.listScoredPostings(0, { includeDismissed: true });
    expect(withDismissed).toHaveLength(1);
    expect(withDismissed[0]?.action).toBe("dismissed");
    repo.close();
  });

  it("clears an action, restoring the match to the default list", () => {
    const repo = newRepo();
    seed(repo, "p1");
    repo.setUserAction("p1", "dismissed");
    expect(repo.clearUserAction("p1")).toBe(true);
    expect(repo.listScoredPostings(0)).toHaveLength(1);
    expect(repo.clearUserAction("p1")).toBe(false);
    repo.close();
  });
});

function makePosting(id: string, title: string): JobPosting {
  return {
    id,
    company: "acme",
    title,
    url: `https://example.test/${id}`,
    source: "test",
    description: "desc",
    fetchedAt: new Date("2026-06-26T00:00:00Z"),
  };
}

describe("scorer tagging + listPostingsForScoring", () => {
  it("tags rows by scorer and lists candidates above the heuristic floor, score desc", () => {
    const repo = newRepo();
    const low = makePosting("low", "Sales Rep");
    const mid = makePosting("mid", "Backend Engineer");
    const high = makePosting("high", "Staff Engineer");
    for (const p of [low, mid, high]) repo.savePosting(p);

    repo.saveMatchResult(low.id, { score: 10, matchedSkills: [], missingSkills: [] });
    repo.saveMatchResult(mid.id, { score: 45, matchedSkills: [], missingSkills: [] });
    repo.saveMatchResult(high.id, { score: 80, matchedSkills: [], missingSkills: [] }, "llm");

    const candidates = repo.listPostingsForScoring({ minHeuristic: 30 });

    expect(candidates.map((c) => c.posting.id)).toEqual([high.id, mid.id]);
    const highCandidate = candidates.find((c) => c.posting.id === high.id);
    const midCandidate = candidates.find((c) => c.posting.id === mid.id);
    expect(highCandidate?.alreadyLlmScored).toBe(true);
    expect(midCandidate?.alreadyLlmScored).toBe(false);
    expect(highCandidate?.heuristicScore).toBe(80);
    repo.close();
  });

  it("excludes expired postings from scoring candidates", () => {
    const repo = newRepo();
    const p = makePosting("p", "Backend Engineer");
    repo.savePosting(p);
    repo.saveMatchResult(p.id, { score: 60, matchedSkills: [], missingSkills: [] });
    repo.markPostingExpired(p.id);

    expect(repo.listPostingsForScoring({ minHeuristic: 30 })).toEqual([]);
    repo.close();
  });

  it("counts only non-expired postings", () => {
    const repo = newRepo();
    const live = makePosting("live", "Backend Engineer");
    const gone = makePosting("gone", "Frontend Engineer");
    repo.savePosting(live);
    repo.savePosting(gone);
    repo.markPostingExpired(gone.id);

    expect(repo.countLivePostings()).toBe(1);
    repo.close();
  });
});

describe("remote and country persistence", () => {
  it("round-trips remote=true and country through savePosting / listScoredPostings", () => {
    const repo = newRepo();
    const p: JobPosting = {
      ...posting,
      id: "remote-1",
      remote: true,
      country: "US",
    };
    repo.savePosting(p);
    repo.saveMatchResult("remote-1", { score: 80, matchedSkills: [], missingSkills: [] });
    const [hit] = repo.listScoredPostings();
    expect(hit?.posting.remote).toBe(true);
    expect(hit?.posting.country).toBe("US");
    repo.close();
  });

  it("round-trips remote=false", () => {
    const repo = newRepo();
    const p: JobPosting = { ...posting, id: "remote-2", remote: false };
    repo.savePosting(p);
    repo.saveMatchResult("remote-2", { score: 70, matchedSkills: [], missingSkills: [] });
    const [hit] = repo.listScoredPostings();
    expect(hit?.posting.remote).toBe(false);
    repo.close();
  });

  it("returns remote and country as undefined when stored as NULL", () => {
    const repo = newRepo();
    repo.savePosting({ ...posting, id: "remote-3" }); // no remote, no country
    repo.saveMatchResult("remote-3", { score: 60, matchedSkills: [], missingSkills: [] });
    const [hit] = repo.listScoredPostings();
    expect(hit?.posting.remote).toBeUndefined();
    expect(hit?.posting.country).toBeUndefined();
    repo.close();
  });

  it("migrate() adds remote and country columns to a pre-existing on-disk DB that lacks them", () => {
    // Write a real DB file with the OLD postings schema (no remote/country), close it, then reopen
    // through Repository — its constructor runs CREATE TABLE IF NOT EXISTS (a no-op on the existing
    // table) followed by migrate(), which must ALTER in the new columns. This exercises the actual
    // upgrade path an existing user hits, not just the fresh-schema path.
    const dir = mkdtempSync(join(tmpdir(), "jobhunter-migrate-"));
    const dbPath = join(dir, "old.db");
    try {
      const old = new Database(dbPath);
      old.exec(`
        CREATE TABLE postings (
          id TEXT PRIMARY KEY,
          company TEXT NOT NULL,
          title TEXT NOT NULL,
          url TEXT NOT NULL,
          source TEXT NOT NULL,
          description TEXT NOT NULL,
          location TEXT,
          posted_at TEXT,
          fetched_at TEXT NOT NULL,
          last_seen_scan INTEGER,
          expired_at TEXT
        );
      `);
      old
        .prepare(
          "INSERT INTO postings (id, company, title, url, source, description, fetched_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "old-1",
          "Old Co",
          "Old Job",
          "https://old.co/1",
          "greenhouse",
          "desc",
          "2026-01-01T00:00:00.000Z",
        );
      old.close();

      // Reopen through Repository — migrate() runs here and must not throw.
      const repo = new Repository(dbPath);

      // The pre-existing row reads back with remote/country undefined (the new columns are NULL).
      repo.saveMatchResult("old-1", { score: 80, matchedSkills: [], missingSkills: [] });
      const afterMigrate = repo.listScoredPostings();
      const old1 = afterMigrate.find((s) => s.posting.id === "old-1");
      expect(old1?.posting.remote).toBeUndefined();
      expect(old1?.posting.country).toBeUndefined();

      // And a new write through the migrated DB persists both columns.
      repo.savePosting({ ...posting, id: "migrated-1", remote: true, country: "Canada" });
      repo.saveMatchResult("migrated-1", { score: 55, matchedSkills: [], missingSkills: [] });
      const migrated = repo.listScoredPostings().find((s) => s.posting.id === "migrated-1");
      expect(migrated?.posting.remote).toBe(true);
      expect(migrated?.posting.country).toBe("Canada");
      repo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

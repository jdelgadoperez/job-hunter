import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobPosting, MatchResult, SkillProfile } from "@app/domain/types";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { Repository, type UserAction } from "./repository";

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

  it("normalizes careers URLs so case and trailing-slash variants don't duplicate", () => {
    const repo = newRepo();
    repo.addTrackedCompany("https://Acme.com/careers/", "Acme");
    // Same company, different casing/trailing slash — must update the existing row, not add one.
    repo.addTrackedCompany("https://acme.com/CAREERS", "Acme Inc");

    expect(repo.listTrackedCompanies()).toEqual([
      { careersUrl: "https://acme.com/careers", name: "Acme Inc" },
    ]);

    // Removal must match on the same normalized key regardless of the casing/slash used to add it.
    expect(repo.removeTrackedCompany("https://ACME.com/careers/")).toBe(true);
    expect(repo.listTrackedCompanies()).toEqual([]);
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

  it("treats case/trailing-slash variants of a careers URL as the same company across scans", () => {
    const repo = newRepo();
    repo.recordDirectory(repo.startScan(), [{ careersUrl: "https://A.com/careers/", name: "A" }]);
    // Same company reported with different casing/trailing slash next scan — must update the
    // existing row rather than being treated as a distinct new company.
    const diff = repo.recordDirectory(repo.startScan(), [
      { careersUrl: "https://a.com/CAREERS", name: "A" },
    ]);
    expect(diff.newCompanies).toEqual([]);
    expect(repo.listDirectoryCompanies()).toEqual([
      { careersUrl: "https://a.com/careers", name: "A" },
    ]);
    repo.close();
  });
});

describe("failed leads", () => {
  it("inserts a new row at consecutive_failures=1 on first failure", () => {
    const repo = newRepo();
    repo.recordScanFailures(1, [
      { careersUrl: "https://boom.com/careers", company: "Boom", message: "render crashed" },
    ]);
    expect(repo.listNeedsAttention(1)).toEqual([
      {
        careersUrl: "https://boom.com/careers",
        company: "Boom",
        message: "render crashed",
        consecutiveFailures: 1,
      },
    ]);
    repo.close();
  });

  it("increments consecutive_failures on repeated failure across scans", () => {
    const repo = newRepo();
    repo.recordScanFailures(1, [
      { careersUrl: "https://boom.com/careers", company: "Boom", message: "timeout" },
    ]);
    repo.recordScanFailures(2, [
      { careersUrl: "https://boom.com/careers", company: "Boom", message: "timeout again" },
    ]);
    const [row] = repo.listNeedsAttention(1);
    expect(row?.consecutiveFailures).toBe(2);
    expect(row?.message).toBe("timeout again");
    repo.close();
  });

  it("deletes the row when a previously-failing company recovers (absent from a later call)", () => {
    const repo = newRepo();
    repo.recordScanFailures(1, [
      { careersUrl: "https://boom.com/careers", company: "Boom", message: "timeout" },
    ]);
    repo.recordScanFailures(2, []); // Boom recovered — not in this scan's failure list
    expect(repo.listNeedsAttention(1)).toEqual([]);
    repo.close();
  });

  it("listNeedsAttention only returns rows at or above the threshold", () => {
    const repo = newRepo();
    for (let scanId = 1; scanId <= 3; scanId++) {
      repo.recordScanFailures(scanId, [
        { careersUrl: "https://boom.com/careers", company: "Boom", message: "timeout" },
      ]);
    }
    expect(repo.listNeedsAttention(5)).toEqual([]);
    expect(repo.listNeedsAttention(3)).toHaveLength(1);
    repo.close();
  });

  it("listRetrySkipUrls returns only the normalized URLs at or above the threshold", () => {
    const repo = newRepo();
    for (let scanId = 1; scanId <= 5; scanId++) {
      repo.recordScanFailures(scanId, [
        { careersUrl: "https://Boom.com/careers/", company: "Boom", message: "timeout" },
      ]);
    }
    expect(repo.listRetrySkipUrls(5)).toEqual(["https://boom.com/careers"]);
    repo.close();
  });

  it("normalizes careers URLs so casing/trailing-slash variants collapse to one row", () => {
    const repo = newRepo();
    repo.recordScanFailures(1, [
      { careersUrl: "https://Boom.com/careers/", company: "Boom", message: "a" },
    ]);
    repo.recordScanFailures(2, [
      { careersUrl: "https://boom.com/CAREERS", company: "Boom", message: "b" },
    ]);
    const rows = repo.listNeedsAttention(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.careersUrl).toBe("https://boom.com/careers");
    expect(rows[0]?.consecutiveFailures).toBe(2);
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

  it("resolves remote to true for a posting with no remote flag and no location (blank = remote)", () => {
    const repo = newRepo();
    repo.savePosting({ ...posting, id: "remote-3" }); // no remote, no country
    repo.saveMatchResult("remote-3", { score: 60, matchedSkills: [], missingSkills: [] });
    const [hit] = repo.listScoredPostings();
    // No stored remote flag + no location → resolvePostingRemote treats blank location as remote.
    expect(hit?.posting.remote).toBe(true);
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

      // The pre-existing row has NULL remote and no location. resolvePostingRemote treats blank
      // location as remote, so the resolved wire value is true (not undefined).
      repo.saveMatchResult("old-1", { score: 80, matchedSkills: [], missingSkills: [] });
      const afterMigrate = repo.listScoredPostings();
      const old1 = afterMigrate.find((s) => s.posting.id === "old-1");
      expect(old1?.posting.remote).toBe(true);
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

describe("listScoredPostings — remote filter and resolved remote on the wire", () => {
  function seedWithRemote(
    repo: Repository,
    id: string,
    score: number,
    remote: boolean | undefined,
    location?: string,
  ): void {
    repo.savePosting({
      ...posting,
      id,
      ...(remote !== undefined ? { remote } : {}),
      ...(location ? { location } : {}),
    });
    repo.saveMatchResult(id, { score, matchedSkills: [], missingSkills: [] });
  }

  it("remoteOnly=true returns only resolved-remote postings", () => {
    const repo = newRepo();
    seedWithRemote(repo, "r1", 90, true); // structured remote=true
    seedWithRemote(repo, "o1", 80, false); // structured remote=false
    seedWithRemote(repo, "r2", 70, undefined, "Remote - US"); // fallback regex resolves true
    seedWithRemote(repo, "o2", 60, undefined, "London, UK"); // fallback regex resolves false

    const all = repo.listScoredPostings(0, { remoteOnly: true });
    const ids = all.map((s) => s.posting.id).sort();
    expect(ids).toEqual(["r1", "r2"]);
    repo.close();
  });

  it("resolved remote on the wire is a definitive boolean, not the raw stored value", () => {
    const repo = newRepo();
    // Stored with no remote flag; location regex makes it remote.
    seedWithRemote(repo, "reg1", 75, undefined, "Remote - US");
    const [hit] = repo.listScoredPostings();
    // The raw stored value is undefined (NULL in SQLite), but the wire value is resolved true.
    expect(hit?.posting.remote).toBe(true);
    repo.close();
  });

  it("remoteOnly=false (default) returns all postings regardless of remote", () => {
    const repo = newRepo();
    seedWithRemote(repo, "a1", 90, true);
    seedWithRemote(repo, "b1", 80, false);
    const all = repo.listScoredPostings();
    expect(all).toHaveLength(2);
    repo.close();
  });
});

describe("listScoredPostings — country filter", () => {
  function seedWithCountry(repo: Repository, id: string, score: number, country?: string): void {
    repo.savePosting({
      ...posting,
      id,
      ...(country ? { country } : {}),
    });
    repo.saveMatchResult(id, { score, matchedSkills: [], missingSkills: [] });
  }

  it("filters by stored country (case-insensitive) and keeps unknown-country postings", () => {
    const repo = newRepo();
    seedWithCountry(repo, "us1", 90, "US");
    seedWithCountry(repo, "de1", 80, "Germany");
    seedWithCountry(repo, "nx1", 70); // no country (unknown)

    // A specific country keeps that country AND unknowns (never silently drops an unparseable
    // location), but excludes other known countries. Ordered by score DESC.
    const us = repo.listScoredPostings(0, { country: "US" });
    expect(us.map((s) => s.posting.id)).toEqual(["us1", "nx1"]);
    expect(us.map((s) => s.posting.id)).not.toContain("de1");

    // Case-insensitive on the known-country match.
    const usLower = repo.listScoredPostings(0, { country: "us" });
    expect(usLower.map((s) => s.posting.id)).toEqual(["us1", "nx1"]);

    repo.close();
  });

  it("returns all postings when country is absent", () => {
    const repo = newRepo();
    seedWithCountry(repo, "c1", 90, "US");
    seedWithCountry(repo, "c2", 80);
    const all = repo.listScoredPostings(0, {});
    expect(all).toHaveLength(2);
    repo.close();
  });

  it("returns only unknown-country postings when no known country matches", () => {
    const repo = newRepo();
    seedWithCountry(repo, "d1", 90, "US"); // a known non-matching country
    seedWithCountry(repo, "dx", 70); // unknown country
    // Filtering for CA matches no known country, but unknown-country postings still come through.
    const result = repo.listScoredPostings(0, { country: "CA" });
    expect(result.map((s) => s.posting.id)).toEqual(["dx"]);
    repo.close();
  });
});

describe("listScoredPostings — applied action", () => {
  function seedWithAction(repo: Repository, id: string, score: number, action?: UserAction): void {
    repo.savePosting({ ...posting, id });
    repo.saveMatchResult(id, { score, matchedSkills: [], missingSkills: [] });
    if (action) repo.setUserAction(id, action);
  }

  it("hides applied postings by default", () => {
    const repo = newRepo();
    seedWithAction(repo, "p-applied", 90, "applied");
    seedWithAction(repo, "p-none", 80);
    const ids = repo.listScoredPostings(0).map((s) => s.posting.id);
    expect(ids).toEqual(["p-none"]);
    repo.close();
  });

  it("reveals applied postings with includeApplied", () => {
    const repo = newRepo();
    seedWithAction(repo, "p-applied", 90, "applied");
    seedWithAction(repo, "p-none", 80);
    const ids = repo.listScoredPostings(0, { includeApplied: true }).map((s) => s.posting.id);
    expect(ids).toEqual(["p-applied", "p-none"]);
    repo.close();
  });

  it("onlyApplied returns just applied postings", () => {
    const repo = newRepo();
    seedWithAction(repo, "p-applied", 90, "applied");
    seedWithAction(repo, "p-saved", 80, "saved");
    seedWithAction(repo, "p-none", 70);
    const ids = repo.listScoredPostings(0, { onlyApplied: true }).map((s) => s.posting.id);
    expect(ids).toEqual(["p-applied"]);
    repo.close();
  });

  it("a no-action posting always shows (never dropped by the applied clause)", () => {
    const repo = newRepo();
    seedWithAction(repo, "p-none", 80);
    expect(repo.listScoredPostings(0).map((s) => s.posting.id)).toEqual(["p-none"]);
    repo.close();
  });

  it("setting applied replaces a prior saved (single-action model)", () => {
    const repo = newRepo();
    seedWithAction(repo, "p", 90, "saved");
    repo.setUserAction("p", "applied");
    // Default list hides it now (applied), and includeApplied shows action=applied.
    expect(repo.listScoredPostings(0).map((s) => s.posting.id)).toEqual([]);
    const [row] = repo.listScoredPostings(0, { includeApplied: true });
    expect(row?.action).toBe("applied");
    repo.close();
  });

  it("onlyApplied still shows an applied posting after it expires (you applied to it)", () => {
    const repo = newRepo();
    // Save under a scan, mark applied, then let it miss two consecutive scans so it expires.
    repo.savePosting(postingWith("p-exp"), repo.startScan());
    repo.saveMatchResult("p-exp", { score: 90, matchedSkills: [], missingSkills: [] });
    repo.setUserAction("p-exp", "applied");
    repo.expireStalePostings(repo.startScan());
    repo.expireStalePostings(repo.startScan());

    // It's expired, so the default list (and a normal includeApplied reveal) hides it...
    expect(repo.listScoredPostings(0, { includeApplied: true }).map((s) => s.posting.id)).toEqual(
      [],
    );
    // ...but the Applied view keeps it — the point of "Applied" spans closed postings.
    const applied = repo.listScoredPostings(0, { onlyApplied: true });
    expect(applied.map((s) => s.posting.id)).toEqual(["p-exp"]);
    expect(applied[0]?.expired).toBe(true);
    repo.close();
  });
});

describe("schema indexes", () => {
  const EXPECTED_INDEXES = [
    "idx_postings_expired_at",
    "idx_postings_last_seen_scan",
    "idx_match_results_score",
  ];

  /** Index names in the DB at `dbPath`, read via an independent connection. */
  function indexNamesAt(dbPath: string): string[] {
    const db = new Database(dbPath, { readonly: true });
    try {
      return (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
          name: string;
        }[]
      ).map((r) => r.name);
    } finally {
      db.close();
    }
  }

  it("creates the hot-path indexes on a fresh database", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobhunter-idx-"));
    const dbPath = join(dir, "fresh.db");
    const repo = new Repository(dbPath);
    repo.close();
    expect(indexNamesAt(dbPath)).toEqual(expect.arrayContaining(EXPECTED_INDEXES));
    rmSync(dir, { recursive: true, force: true });
  });

  it("migrates and indexes a legacy database that predates the expired_at/remote columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobhunter-legacy-"));
    const dbPath = join(dir, "legacy.db");
    // Simulate an old DB: postings without last_seen_scan/expired_at/remote/country, and
    // match_results without scorer — exactly what migrate() + the index creation must tolerate.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE postings (
        id TEXT PRIMARY KEY, company TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
        source TEXT NOT NULL, description TEXT NOT NULL, location TEXT, posted_at TEXT,
        fetched_at TEXT NOT NULL
      );
      CREATE TABLE match_results (
        posting_id TEXT PRIMARY KEY REFERENCES postings(id), score INTEGER NOT NULL,
        matched_skills TEXT NOT NULL, missing_skills TEXT NOT NULL, rationale TEXT
      );
    `);
    legacy.close();

    // Opening the repo runs SCHEMA then migrate() — must not throw on the missing columns, and the
    // indexes must end up created after the ALTERs add the columns they reference.
    const repo = new Repository(dbPath);
    repo.close();
    expect(indexNamesAt(dbPath)).toEqual(expect.arrayContaining(EXPECTED_INDEXES));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("search filter", () => {
  const seedForSearch = (repo: Repository): void => {
    const seeds: JobPosting[] = [
      {
        ...posting,
        id: "s-title",
        company: "Acme",
        title: "Staff Platform Engineer",
        location: "Berlin",
        description: "Own the deployment pipeline.",
      },
      {
        ...posting,
        id: "s-company",
        company: "Globex Robotics",
        title: "Engineer",
        location: "Berlin",
        description: "General role.",
      },
      {
        ...posting,
        id: "s-location",
        company: "Acme",
        title: "Engineer",
        location: "Reykjavik",
        description: "General role.",
      },
      {
        ...posting,
        id: "s-description",
        company: "Acme",
        title: "Engineer",
        location: "Berlin",
        description: "Deep Kubernetes and Terraform experience required.",
      },
    ];
    for (const p of seeds) {
      repo.savePosting(p);
      repo.saveMatchResult(p.id, { score: 80, matchedSkills: [], missingSkills: [] });
    }
  };

  const idsFor = (repo: Repository, search: string): string[] =>
    repo
      .listScoredPostings(0, { search })
      .map((s) => s.posting.id)
      .sort();

  it("matches on title", () => {
    const repo = newRepo();
    seedForSearch(repo);
    expect(idsFor(repo, "Platform")).toEqual(["s-title"]);
    repo.close();
  });

  it("matches on company", () => {
    const repo = newRepo();
    seedForSearch(repo);
    expect(idsFor(repo, "Globex")).toEqual(["s-company"]);
    repo.close();
  });

  it("matches on location", () => {
    const repo = newRepo();
    seedForSearch(repo);
    expect(idsFor(repo, "Reykjavik")).toEqual(["s-location"]);
    repo.close();
  });

  it("matches on description", () => {
    const repo = newRepo();
    seedForSearch(repo);
    expect(idsFor(repo, "Terraform")).toEqual(["s-description"]);
    repo.close();
  });

  it("is case-insensitive", () => {
    const repo = newRepo();
    seedForSearch(repo);
    expect(idsFor(repo, "gLoBeX")).toEqual(["s-company"]);
    repo.close();
  });

  it("excludes non-matching postings", () => {
    const repo = newRepo();
    seedForSearch(repo);
    expect(repo.listScoredPostings(0, { search: "no-such-token" })).toEqual([]);
    repo.close();
  });

  it("treats an empty or whitespace search as no filter", () => {
    const repo = newRepo();
    seedForSearch(repo);
    const unfiltered = repo.listScoredPostings(0).length;
    expect(repo.listScoredPostings(0, { search: "" })).toHaveLength(unfiltered);
    expect(repo.listScoredPostings(0, { search: "   " })).toHaveLength(unfiltered);
    repo.close();
  });
});

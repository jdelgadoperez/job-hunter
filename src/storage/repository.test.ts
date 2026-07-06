import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCompanyId } from "@app/discovery/company-id";
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

  it("does not report removed companies when computeRemoved is false", () => {
    const repo = newRepo();
    const scan1 = repo.startScan("full");
    repo.recordDirectory(scan1, [
      { careersUrl: "https://a.example/careers" },
      { careersUrl: "https://b.example/careers" },
    ]);
    const scan2 = repo.startScan("retry");
    const diff = repo.recordDirectory(scan2, [{ careersUrl: "https://a.example/careers" }], {
      computeRemoved: false,
    });
    expect(diff.removedCompanies).toEqual([]);
    expect(diff.newCompanies).toEqual([]);
    // But company A was still upserted/refreshed this scan (last_seen_scan advanced).
    // biome-ignore lint/complexity/useLiteralKeys: bracket access reaches the private `db` field.
    const a = repo["db"]
      .prepare("SELECT last_seen_scan FROM companies WHERE careers_url = ?")
      .get("https://a.example/careers") as { last_seen_scan: number };
    expect(a.last_seen_scan).toBe(scan2);
    repo.close();
  });
});

describe("scan kind", () => {
  it("records the scan kind, defaulting to full", () => {
    const repo = newRepo();
    const fullId = repo.startScan();
    const retryId = repo.startScan("retry");
    const kindOf = (id: number) =>
      // biome-ignore lint/complexity/useLiteralKeys: bracket access reaches the private `db` field.
      (repo["db"].prepare("SELECT kind FROM scans WHERE id = ?").get(id) as { kind: string }).kind;
    expect(kindOf(fullId)).toBe("full");
    expect(kindOf(retryId)).toBe("retry");
    repo.close();
  });
});

describe("failed leads", () => {
  it("inserts a new row at consecutive_failures=1 on first failure", () => {
    const repo = newRepo();
    repo.recordScanFailures(
      1,
      [{ careersUrl: "https://boom.com/careers", company: "Boom", message: "render crashed" }],
      ["https://boom.com/careers"],
    );
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
    repo.recordScanFailures(
      1,
      [{ careersUrl: "https://boom.com/careers", company: "Boom", message: "timeout" }],
      ["https://boom.com/careers"],
    );
    repo.recordScanFailures(
      2,
      [{ careersUrl: "https://boom.com/careers", company: "Boom", message: "timeout again" }],
      ["https://boom.com/careers"],
    );
    const [row] = repo.listNeedsAttention(1);
    expect(row?.consecutiveFailures).toBe(2);
    expect(row?.message).toBe("timeout again");
    repo.close();
  });

  it("deletes the row when a previously-failing company recovers on a full scan that attempted it", () => {
    const repo = newRepo();
    repo.recordScanFailures(
      1,
      [{ careersUrl: "https://boom.com/careers", company: "Boom", message: "timeout" }],
      ["https://boom.com/careers"],
    );
    // Boom recovered: this scan attempted it (full scan, so attemptedUrls includes it) but it's
    // absent from the failures list.
    repo.recordScanFailures(2, [], ["https://boom.com/careers"]);
    expect(repo.listNeedsAttention(1)).toEqual([]);
    repo.close();
  });

  it("a scoped rescan does not delete failure rows for companies it didn't crawl", () => {
    const repo = newRepo();
    const companyAUrl = "https://a.com/careers";
    const companyBUrl = "https://b.com/careers";

    // Full scans 1-3: both A and B fail every time, so B accumulates a sub-threshold history.
    const fullScanAttemptedUrls = [companyAUrl, companyBUrl];
    for (let scanId = 1; scanId <= 3; scanId++) {
      repo.recordScanFailures(
        scanId,
        [
          { careersUrl: companyAUrl, company: "A", message: "timeout" },
          { careersUrl: companyBUrl, company: "B", message: "timeout" },
        ],
        fullScanAttemptedUrls,
      );
    }
    const seededB = repo.listNeedsAttention(1).find((row) => row.careersUrl === companyBUrl);
    const seededBFailureCount = seededB?.consecutiveFailures;

    // Scoped retry-failed rescan: only A was attempted (B was never crawled this run), and A
    // recovered (absent from the failures list).
    repo.recordScanFailures(4, [], [companyAUrl]);

    const rows = repo.listNeedsAttention(1);
    const rowForA = rows.find((row) => row.careersUrl === companyAUrl);
    const rowForB = rows.find((row) => row.careersUrl === companyBUrl);

    // A was attempted and recovered: its row is gone.
    expect(rowForA).toBeUndefined();
    // B was never attempted this run: its row and accumulated failure count are untouched.
    expect(rowForB?.consecutiveFailures).toBe(seededBFailureCount);
    repo.close();
  });

  it("listNeedsAttention only returns rows at or above the threshold", () => {
    const repo = newRepo();
    for (let scanId = 1; scanId <= 3; scanId++) {
      repo.recordScanFailures(
        scanId,
        [{ careersUrl: "https://boom.com/careers", company: "Boom", message: "timeout" }],
        ["https://boom.com/careers"],
      );
    }
    expect(repo.listNeedsAttention(5)).toEqual([]);
    expect(repo.listNeedsAttention(3)).toHaveLength(1);
    repo.close();
  });

  it("listRetrySkipUrls returns only the normalized URLs at or above the threshold", () => {
    const repo = newRepo();
    for (let scanId = 1; scanId <= 5; scanId++) {
      repo.recordScanFailures(
        scanId,
        [{ careersUrl: "https://Boom.com/careers/", company: "Boom", message: "timeout" }],
        ["https://Boom.com/careers/"],
      );
    }
    expect(repo.listRetrySkipUrls(5)).toEqual(["https://boom.com/careers"]);
    repo.close();
  });

  it("normalizes careers URLs so casing/trailing-slash variants collapse to one row", () => {
    const repo = newRepo();
    repo.recordScanFailures(
      1,
      [{ careersUrl: "https://Boom.com/careers/", company: "Boom", message: "a" }],
      ["https://Boom.com/careers/"],
    );
    repo.recordScanFailures(
      2,
      [{ careersUrl: "https://boom.com/CAREERS", company: "Boom", message: "b" }],
      ["https://boom.com/CAREERS"],
    );
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

  /** Start and finish a scan — only *finished* scans advance the staleness clock. */
  function finishedScan(repo: Repository, kind: "full" | "retry" = "full"): number {
    const id = repo.startScan(kind);
    repo.finishScan(id, {
      postingsSeen: 0,
      companiesSeen: 0,
      newCompanies: [],
      removedCompanies: [],
    });
    return id;
  }

  it("expires a posting after it misses two consecutive scans, and revives it on return", () => {
    const repo = newRepo();
    const s1 = repo.startScan();
    seedScored(repo, "p1", s1);

    // One missed scan: still listed.
    expect(repo.expireStalePostings(finishedScan(repo))).toBe(0);
    expect(repo.listScoredPostings(0)).toHaveLength(1);

    // Second consecutive miss: expired and dropped from the default list.
    const expired = repo.expireStalePostings(finishedScan(repo));
    expect(expired).toBe(1);
    expect(repo.listScoredPostings(0)).toHaveLength(0);
    expect(repo.listScoredPostings(0, { includeExpired: true })).toHaveLength(1);

    // Seen again in a later scan: revived.
    seedScored(repo, "p1", repo.startScan());
    expect(repo.listScoredPostings(0)).toHaveLength(1);
    repo.close();
  });

  it("does NOT count an unfinished (crashed/killed) scan toward the staleness clock", () => {
    const repo = newRepo();
    seedScored(repo, "p1", repo.startScan());

    // Two full scans elapse, but both crashed before finishScan (finished_at stays NULL). A
    // consecutive-miss expiry must not fire on scans that never actually completed a crawl —
    // otherwise a worker that OOMs or hits its hard job-timeout twice would expire live postings.
    repo.startScan("full"); // unfinished
    const secondUnfinished = repo.startScan("full"); // unfinished
    expect(repo.expireStalePostings(secondUnfinished)).toBe(0);
    expect(repo.listScoredPostings(0)).toHaveLength(1);

    // Once two scans actually FINISH without re-seeing p1, it expires as expected.
    finishedScan(repo);
    expect(repo.expireStalePostings(finishedScan(repo))).toBe(1);
    expect(repo.listScoredPostings(0)).toHaveLength(0);
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

  it("counts only full scans toward staleness, so retry scans never expire healthy postings", () => {
    const repo = newRepo();
    // Full scan #1: a healthy posting is seen.
    const scan1 = repo.startScan("full");
    repo.savePosting(postingWith("p1"), scan1);

    // Two scoped retry scans happen (e.g. the user iterates on flaky companies).
    finishedScan(repo, "retry");
    finishedScan(repo, "retry");
    // Even though the raw scanId gap is now >= 2, only 0 FULL scans have elapsed since scan1,
    // so nothing is stale.
    expect(repo.expireStalePostings(finishedScan(repo, "retry"))).toBe(0);

    // A genuine second AND third full scan (that don't re-see p1) DO make it stale.
    finishedScan(repo);
    const laterFull = finishedScan(repo);
    expect(repo.expireStalePostings(laterFull)).toBe(1);
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

  it("round-trips the heuristic-location-penalized scorer tag", () => {
    const repo = newRepo();
    const p = makePosting("location-penalized", "Backend Engineer");
    repo.savePosting(p);
    repo.saveMatchResult(
      p.id,
      { score: 40, matchedSkills: [], missingSkills: [] },
      "heuristic-location-penalized",
    );

    const candidates = repo.listPostingsForScoring({ minHeuristic: 30 });
    const candidate = candidates.find((c) => c.posting.id === p.id);

    expect(candidate?.scorer).toBe("heuristic-location-penalized");
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

describe("country backfill on migrate", () => {
  it("fills country for now-parseable locations, leaves bare cities NULL, and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobhunter-country-backfill-"));
    const dbPath = join(dir, "legacy.db");
    try {
      // A minimal legacy postings table WITH a country column but NULL values, mimicking rows the
      // old parser couldn't resolve. (The country column already exists on any DB that ran a prior
      // migrate; we set it NULL here to represent unresolved rows.)
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE postings (
          id TEXT PRIMARY KEY, company TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
          source TEXT NOT NULL, description TEXT NOT NULL, location TEXT, posted_at TEXT,
          fetched_at TEXT NOT NULL, last_seen_scan INTEGER, expired_at TEXT, country TEXT
        );
      `);
      const insert = raw.prepare(
        "INSERT INTO postings (id, company, title, url, source, description, location, fetched_at, country) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      );
      const t = "2026-01-01T00:00:00.000Z";
      insert.run("p-tx", "acme", "Eng", "https://a/1", "greenhouse", "", "Austin, Texas", t);
      insert.run("p-sf", "acme", "Eng", "https://a/2", "greenhouse", "", "San Francisco", t);
      insert.run("p-empty", "acme", "Eng", "https://a/3", "greenhouse", "", "", t);
      raw.close();

      // Reopen through Repository — migrate() runs and backfills country.
      new Repository(dbPath);

      const check = new Database(dbPath);
      const country = (id: string) =>
        (
          check.prepare("SELECT country FROM postings WHERE id = ?").get(id) as {
            country: string | null;
          }
        ).country;
      expect(country("p-tx")).toBe("US");
      expect(country("p-sf")).toBeNull();
      expect(country("p-empty")).toBeNull();
      check.close();

      // Idempotent: a second migrate() (via re-open) leaves the same values.
      new Repository(dbPath);
      const check2 = new Database(dbPath);
      expect(
        (
          check2.prepare("SELECT country FROM postings WHERE id = ?").get("p-tx") as {
            country: string | null;
          }
        ).country,
      ).toBe("US");
      check2.close();
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
    // Save under a scan, mark applied, then let it miss two consecutive FINISHED scans so it expires
    // (only finished scans advance the staleness clock).
    const finishScan = (): number => {
      const id = repo.startScan();
      repo.finishScan(id, {
        postingsSeen: 0,
        companiesSeen: 0,
        newCompanies: [],
        removedCompanies: [],
      });
      return id;
    };
    repo.savePosting(postingWith("p-exp"), repo.startScan());
    repo.saveMatchResult("p-exp", { score: 90, matchedSkills: [], missingSkills: [] });
    repo.setUserAction("p-exp", "applied");
    repo.expireStalePostings(finishScan());
    repo.expireStalePostings(finishScan());

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
    "idx_companies_last_seen_at",
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

  it("migrate creates an index on companies.last_seen_at (incremental-scan hot path)", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobhunter-idx-last-seen-"));
    const dbPath = join(dir, "fresh.db");
    const repo = new Repository(dbPath);
    const raw = new Database(dbPath, { readonly: true });
    try {
      const indexes = raw.prepare("PRAGMA index_list('companies')").all() as { name: string }[];
      expect(indexes.some((i) => i.name === "idx_companies_last_seen_at")).toBe(true);
    } finally {
      raw.close();
    }
    repo.close();
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

describe("companyId columns", () => {
  it("backfills companies.id and failed_leads.company_id on migrate", () => {
    const repo = newRepo();
    const scan = repo.startScan();
    repo.recordDirectory(scan, [{ careersUrl: "https://boards.greenhouse.io/acme", name: "Acme" }]);
    // seed a failed_leads row (5x per the threshold precedent used elsewhere in this file)
    for (let i = 0; i < 5; i++) {
      repo.recordScanFailures(
        repo.startScan(),
        [{ careersUrl: "https://boards.lever.co/boom", company: "Boom", message: "x" }],
        ["https://boards.lever.co/boom"],
      );
    }
    // biome-ignore lint/complexity/useLiteralKeys: bracket access reaches the private `db` field.
    const companyRow = repo["db"]
      .prepare("SELECT id FROM companies WHERE careers_url = ?")
      .get("https://boards.greenhouse.io/acme") as { id: string };
    // biome-ignore lint/complexity/useLiteralKeys: bracket access reaches the private `db` field.
    const leadRow = repo["db"]
      .prepare("SELECT company_id FROM failed_leads WHERE careers_url = ?")
      .get("https://boards.lever.co/boom") as { company_id: string };
    expect(companyRow.id).toBe(makeCompanyId("https://boards.greenhouse.io/acme"));
    expect(leadRow.company_id).toBe(makeCompanyId("https://boards.lever.co/boom"));
    repo.close();
  });

  it("migrates a legacy DB whose un-normalized companies rows collide on companyId", () => {
    // Reproduce the real crash: a database populated BEFORE careers_url normalization (PR #83)
    // holds distinct raw-URL rows — e.g. `.../careers` and `.../careers/` — that back-fill to the
    // SAME companyId. The initial companyId release put a UNIQUE index over companies.id, so
    // migrate() threw `UNIQUE constraint failed: companies.id`. Opening a Repository over such a DB
    // must now migrate cleanly (non-unique index). A file DB is used so the seeded rows survive
    // being reopened by the Repository's own connection.
    const a = "https://acme.com/careers";
    const b = "https://acme.com/careers/";
    expect(makeCompanyId(a)).toBe(makeCompanyId(b)); // distinct raw URLs, same companyId

    const dir = mkdtempSync(join(tmpdir(), "job-hunter-migrate-"));
    const dbPath = join(dir, "legacy.db");
    try {
      const seed = new Database(dbPath);
      // Pre-#83, pre-companyId shape: companies keyed by raw careers_url, no id column.
      seed.exec(
        "CREATE TABLE companies (careers_url TEXT PRIMARY KEY, name TEXT, first_seen_scan INTEGER NOT NULL, last_seen_scan INTEGER NOT NULL, last_seen_at TEXT NOT NULL DEFAULT (datetime('now')))",
      );
      const insert = seed.prepare(
        "INSERT INTO companies (careers_url, name, first_seen_scan, last_seen_scan) VALUES (?, ?, 1, 1)",
      );
      insert.run(a, "Acme");
      insert.run(b, "Acme");
      seed.close();

      let repo: Repository | undefined;
      expect(() => {
        repo = new Repository(dbPath); // runs SCHEMA + migrate(): backfill id + build the index
      }).not.toThrow();
      if (!repo) throw new Error("repo not constructed");

      // biome-ignore lint/complexity/useLiteralKeys: bracket access reaches the private `db` field.
      const rows = repo["db"]
        .prepare("SELECT careers_url, id FROM companies ORDER BY careers_url")
        .all() as { careers_url: string; id: string }[];
      // Both legacy rows survive and share the backfilled companyId.
      expect(rows.map((r) => r.id)).toEqual([makeCompanyId(a), makeCompanyId(b)]);
      // biome-ignore lint/complexity/useLiteralKeys: bracket access reaches the private `db` field.
      const idx = repo["db"]
        .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_companies_id'")
        .get() as { sql: string };
      expect(idx.sql.toLowerCase()).not.toContain("unique");
      repo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces a pre-existing UNIQUE idx_companies_id from the initial companyId release on migrate", () => {
    // A database migrated by the buggy first release that DID manage to build the UNIQUE index (its
    // companies rows happened not to collide at the time). A later colliding insert would be
    // rejected by that unique index, so migrate() must DROP and rebuild it as non-unique. A file DB
    // is used because the index state must survive being reopened by a second connection.
    const dir = mkdtempSync(join(tmpdir(), "job-hunter-uniqueidx-"));
    const dbPath = join(dir, "legacy.db");
    try {
      const seed = new Database(dbPath);
      seed.exec(
        "CREATE TABLE companies (careers_url TEXT PRIMARY KEY, id TEXT, name TEXT, first_seen_scan INTEGER NOT NULL, last_seen_scan INTEGER NOT NULL, last_seen_at TEXT NOT NULL DEFAULT (datetime('now')))",
      );
      seed.exec("CREATE UNIQUE INDEX idx_companies_id ON companies(id)");
      seed.close();

      const repo = new Repository(dbPath);
      // biome-ignore lint/complexity/useLiteralKeys: bracket access reaches the private `db` field.
      const idx = repo["db"]
        .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_companies_id'")
        .get() as { sql: string };
      expect(idx.sql.toLowerCase()).not.toContain("unique");
      repo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists companyId on savePosting and leaves a companyId-less posting NULL", () => {
    const repo = newRepo();
    const scan = repo.startScan();
    repo.savePosting({ ...makePosting("p1", "Engineer"), companyId: "abc123def4567890" }, scan);
    repo.savePosting(makePosting("p2", "Engineer")); // no companyId
    // biome-ignore lint/complexity/useLiteralKeys: bracket access reaches the private `db` field.
    const p1 = repo["db"].prepare("SELECT company_id FROM postings WHERE id = ?").get("p1") as {
      company_id: string | null;
    };
    // biome-ignore lint/complexity/useLiteralKeys: bracket access reaches the private `db` field.
    const p2 = repo["db"].prepare("SELECT company_id FROM postings WHERE id = ?").get("p2") as {
      company_id: string | null;
    };
    expect(p1.company_id).toBe("abc123def4567890");
    expect(p2.company_id).toBeNull();
    repo.close();
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

describe("listFreshCompanyUrls", () => {
  it("returns companies scanned within the window and excludes stale ones; empty when hours<=0", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobhunter-fresh-"));
    const dbPath = join(dir, "fresh.db");
    try {
      // Construct once so migrate() creates the schema, then seed rows directly on a raw handle.
      new Repository(dbPath);
      const raw = new Database(dbPath);
      // A company scanned "now" (fresh) and one scanned 48h ago (stale).
      raw
        .prepare(
          "INSERT INTO companies (careers_url, name, first_seen_scan, last_seen_scan, last_seen_at) " +
            "VALUES (?, ?, 1, 1, datetime('now'))",
        )
        .run("https://fresh.co/careers", "Fresh Co");
      raw
        .prepare(
          "INSERT INTO companies (careers_url, name, first_seen_scan, last_seen_scan, last_seen_at) " +
            "VALUES (?, ?, 1, 1, datetime('now', '-48 hours'))",
        )
        .run("https://stale.co/careers", "Stale Co");
      raw.close();

      // Re-open so the repo reads the seeded rows.
      const repo2 = new Repository(dbPath);
      const fresh = repo2.listFreshCompanyUrls(24);
      expect(fresh).toContain("https://fresh.co/careers");
      expect(fresh).not.toContain("https://stale.co/careers");

      // hours<=0 disables skipping entirely.
      expect(repo2.listFreshCompanyUrls(0)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

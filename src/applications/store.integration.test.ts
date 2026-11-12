import type { JobPosting } from "@app/domain/types";
import { Repository } from "@app/storage/repository";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApplicationError, isIsoDate, localToday } from "./store";

const TODAY = "2026-11-11";

const posting: JobPosting = {
  id: "p1",
  company: "Acme",
  title: "Staff Engineer",
  url: "https://acme.example/jobs/1",
  source: "greenhouse",
  description: "TypeScript",
  fetchedAt: new Date("2026-11-01T00:00:00Z"),
};

let repo: Repository;
beforeEach(() => {
  repo = new Repository(":memory:", { today: () => TODAY });
});
afterEach(() => repo.close());

describe("date helpers", () => {
  it("formats the local calendar date", () => {
    expect(localToday(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
  });

  it("accepts only real YYYY-MM-DD dates", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-2-3")).toBe(false);
    expect(isIsoDate("yesterday")).toBe(false);
  });
});

describe("ApplicationStore", () => {
  it("adds an application with an opening note, defaulting the date to today", () => {
    const app = repo.applications.add({
      company: "  Acme ",
      role: "Engineer",
      url: " https://acme.example ",
      source: "",
    });
    expect(app).toMatchObject({
      company: "Acme",
      role: "Engineer",
      status: "applied",
      dateApplied: TODAY,
      url: "https://acme.example",
      source: null,
      postingId: null,
      archived: false,
    });
    expect(app.notes).toEqual([
      { id: expect.any(Number), applicationId: app.id, date: TODAY, content: "Applied" },
    ]);
  });

  it("rejects missing names, bad dates, and bad statuses", () => {
    const store = repo.applications;
    expect(() => store.add({ company: " ", role: "x" })).toThrow(ApplicationError);
    expect(() => store.add({ company: "x", role: "" })).toThrow("role is required");
    expect(() => store.add({ company: "x", role: "y", dateApplied: "2026-13-01" })).toThrow(
      "invalid date",
    );
    expect(() =>
      // @ts-expect-error — exercising the runtime guard
      store.add({ company: "x", role: "y", status: "hired" }),
    ).toThrow("invalid status");
  });

  it("lists newest first, filters by status, and separates archived", () => {
    const store = repo.applications;
    const old = store.add({ company: "Old", role: "r", dateApplied: "2026-01-01" });
    const mid = store.add({ company: "Mid", role: "r", dateApplied: "2026-06-01" });
    store.add({ company: "New", role: "r", dateApplied: "2026-10-01" });
    store.setStatus(mid.id, "screened");
    store.setStatus(old.id, "rejected");
    store.archive(old.id);

    expect(store.list().map((a) => a.company)).toEqual(["New", "Mid"]);
    expect(store.list({ status: "screened" }).map((a) => a.company)).toEqual(["Mid"]);
    expect(store.list({ archived: true }).map((a) => a.company)).toEqual(["Old"]);
    expect(store.countsByStatus()).toEqual({ applied: 1, screened: 1 });
    expect(store.countsByStatus({ archived: true })).toEqual({ rejected: 1 });
  });

  it("logs status changes as dated notes and ignores no-op changes", () => {
    const store = repo.applications;
    const app = store.add({ company: "Acme", role: "r" });
    store.setStatus(app.id, "interviewed", "2026-11-20");
    const same = store.setStatus(app.id, "interviewed");
    expect(same.status).toBe("interviewed");
    expect(same.notes.map((n) => [n.date, n.content])).toEqual([
      [TODAY, "Applied"],
      ["2026-11-20", "Status changed from Applied to Interviewed"],
    ]);
    expect(() => store.setStatus(app.id, "offered", "soon")).toThrow("invalid date");
    // @ts-expect-error — exercising the runtime guard
    expect(() => store.setStatus(app.id, "hired")).toThrow("invalid status");
  });

  it("adds notes and rejects empty ones or unknown ids", () => {
    const store = repo.applications;
    const app = store.add({ company: "Acme", role: "r" });
    expect(store.addNote(app.id, "  Recruiter call  ", "2026-11-12")).toMatchObject({
      date: "2026-11-12",
      content: "Recruiter call",
    });
    expect(() => store.addNote(app.id, "   ")).toThrow("note is empty");
    expect(() => store.addNote(app.id, "x", "nope")).toThrow("invalid date");
    expect(() => store.addNote(999, "x")).toThrow("no application with id 999");
  });

  it("updates fields, clears optional ones, and validates", () => {
    const store = repo.applications;
    const app = store.add({ company: "Acme", role: "r", recruiter: "Sam" });
    const updated = store.update(app.id, {
      role: "Senior r",
      recruiter: null,
      salaryRange: "200k",
      dateApplied: "2026-11-01",
    });
    expect(updated).toMatchObject({
      role: "Senior r",
      recruiter: null,
      salaryRange: "200k",
      dateApplied: "2026-11-01",
    });
    expect(store.update(app.id, {})).toMatchObject({ role: "Senior r" });
    expect(() => store.update(app.id, { company: " " })).toThrow("company cannot be empty");
    expect(() => store.update(app.id, { dateApplied: "x" })).toThrow("invalid date");
    expect(() => store.update(999, { role: "x" })).toThrow("no application");
  });

  it("only archives closed applications and can restore them", () => {
    const store = repo.applications;
    const app = store.add({ company: "Acme", role: "r" });
    expect(() => store.archive(app.id)).toThrow("cannot archive");
    expect(store.listArchivable()).toEqual([]);
    store.setStatus(app.id, "ghosted");
    expect(store.listArchivable().map((a) => a.id)).toEqual([app.id]);
    expect(store.archive(app.id).archived).toBe(true);
    expect(store.unarchive(app.id).archived).toBe(false);
  });

  it("searches every field and note content, archived included", () => {
    const store = repo.applications;
    const a = store.add({ company: "Acme", role: "Engineer", recruiter: "Dana Smith" });
    const b = store.add({ company: "Globex", role: "Designer" });
    store.addNote(b.id, "Referral from Pat");
    store.setStatus(a.id, "withdrawn");
    store.archive(a.id);
    expect(store.search("dana").map((x) => x.id)).toEqual([a.id]);
    expect(store.search("referral").map((x) => x.id)).toEqual([b.id]);
    expect(store.search("zzz")).toEqual([]);
  });

  it("resolves selectors by id, exact name, or unique partial name", () => {
    const store = repo.applications;
    const a = store.add({ company: "Acme", role: "One" });
    const b = store.add({ company: "Acme Labs", role: "Two" });
    const c = store.add({ company: "Globex", role: "Three" });
    expect(store.resolve(String(c.id)).id).toBe(c.id);
    expect(store.resolve("acme").id).toBe(a.id); // exact beats partial
    expect(store.resolve("labs").id).toBe(b.id);
    expect(store.resolve("glob").id).toBe(c.id);
    expect(() => store.resolve("nope")).toThrow('no application matches "nope"');
    expect(() => store.resolve("nope", { archived: true })).toThrow("no archived application");

    store.add({ company: "Acme", role: "Another" });
    expect(() => store.resolve("acme")).toThrow(/matches 2 applications; use the id/);
  });

  it("removes an application with its notes", () => {
    const store = repo.applications;
    const app = store.add({ company: "Acme", role: "r" });
    store.addNote(app.id, "x");
    expect(store.remove(app.id)).toBe(true);
    expect(store.get(app.id)).toBeUndefined();
    expect(store.remove(app.id)).toBe(false);
  });

  it("links only stored postings, once, and keeps the match action in step", () => {
    const store = repo.applications;
    expect(() => store.add({ company: "Acme", role: "r", postingId: "nope" })).toThrow(
      "no stored posting with id nope",
    );
    repo.savePosting(posting);
    repo.saveMatchResult(posting.id, { score: 80, matchedSkills: [], missingSkills: [] });
    const app = store.add({ company: "Acme", role: "r", postingId: "p1" });
    expect(repo.listScoredPostings(0, { onlyApplied: true })).toHaveLength(1);
    expect(() => store.add({ company: "Acme", role: "r", postingId: "p1" })).toThrow(
      "already has an application",
    );
    expect(store.remove(app.id)).toBe(true);
    expect(repo.listScoredPostings(0, { onlyApplied: true })).toHaveLength(0);
  });

  it("removing an application leaves a non-applied match action alone", () => {
    repo.savePosting(posting);
    const app = repo.applications.add({ company: "Acme", role: "r", postingId: "p1" });
    repo.connection.prepare("UPDATE user_actions SET action = 'saved'").run();
    repo.applications.remove(app.id);
    expect(repo.connection.prepare("SELECT action FROM user_actions").get()).toEqual({
      action: "saved",
    });
  });

  it("resolves active first, then archived", () => {
    const store = repo.applications;
    const old = store.add({ company: "Initech", role: "r" });
    store.setStatus(old.id, "ghosted");
    store.archive(old.id);
    expect(store.resolveIncludingArchived("initech").id).toBe(old.id);
    const current = store.add({ company: "Initech", role: "r2" });
    expect(store.resolveIncludingArchived("initech").id).toBe(current.id);
    expect(() => store.resolveIncludingArchived("nobody")).toThrow(
      'no application matches "nobody"',
    );
  });
});

describe("match ↔ application linkage", () => {
  beforeEach(() => {
    repo.savePosting(posting);
    repo.saveMatchResult(posting.id, { score: 80, matchedSkills: [], missingSkills: [] });
  });

  it("marking a match applied opens one application from the posting", () => {
    repo.setUserAction(posting.id, "applied");
    repo.setUserAction(posting.id, "applied");
    const apps = repo.applications.list();
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      company: "Acme",
      role: "Staff Engineer",
      url: posting.url,
      source: "greenhouse",
      postingId: "p1",
    });
  });

  it("skips unknown postings without failing", () => {
    expect(repo.applications.ensureForPosting("ghost")).toBeUndefined();
    expect(repo.applications.releasePosting("ghost")).toBe(false);
    expect(repo.applications.list()).toEqual([]);
  });

  it("un-marking an untouched application deletes it", () => {
    repo.setUserAction(posting.id, "applied");
    expect(repo.clearUserAction(posting.id)).toBe(true);
    expect(repo.applications.list()).toEqual([]);
  });

  it("un-marking keeps an application the user has worked on, just unlinked", () => {
    repo.setUserAction(posting.id, "applied");
    const app = repo.applications.getByPostingId(posting.id);
    if (!app) throw new Error("expected an application");
    repo.applications.addNote(app.id, "Phone screen booked");
    repo.setUserAction(posting.id, "saved");
    expect(repo.applications.get(app.id)?.postingId).toBeNull();
    expect(repo.applications.list()).toHaveLength(1);
  });

  it("backfills applications for matches marked applied before tracking existed", () => {
    repo.connection
      .prepare(
        "INSERT INTO user_actions (posting_id, action, updated_at) VALUES (?, 'applied', '2026-08-03 12:00:00')",
      )
      .run(posting.id);
    expect(repo.applications.list()).toEqual([]);
    expect(repo.applications.backfillFromAppliedMatches()).toBe(1);
    expect(repo.applications.backfillFromAppliedMatches()).toBe(0);
    expect(repo.applications.list()).toMatchObject([
      { company: "Acme", postingId: "p1", dateApplied: "2026-08-03" },
    ]);
  });

  it("un-marking keeps an application that has documents (and the documents)", () => {
    repo.setUserAction(posting.id, "applied");
    const app = repo.applications.getByPostingId(posting.id);
    if (!app) throw new Error("expected an application");
    repo.documents.saveNote(app.id, "prep.md", "# Prep");
    repo.clearUserAction(posting.id);
    expect(repo.applications.get(app.id)?.postingId).toBeNull();
    expect(repo.documents.list(app.id).map((d) => d.name)).toEqual(["prep.md"]);
  });

  it("survives the posting expiring", () => {
    repo.setUserAction(posting.id, "applied");
    repo.markPostingExpired(posting.id);
    expect(repo.applications.list()).toHaveLength(1);
  });
});

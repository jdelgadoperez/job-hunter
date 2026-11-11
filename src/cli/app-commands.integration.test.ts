import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "@app/storage/repository";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AppCommandDeps, runAppCommand } from "./app-commands";
import { parseAppCommand } from "./parse-app";

let repo: Repository;
let out: string[];
let err: string[];
let importCalls: (string | undefined)[];

function deps(overrides: Partial<AppCommandDeps> = {}): AppCommandDeps {
  return {
    repo,
    log: (m) => out.push(m),
    diag: (m) => err.push(m),
    importJt: (path) => {
      importCalls.push(path);
      return { imported: 2, skipped: 1, notes: 5, path: path ?? "/default/jt.db" };
    },
    ...overrides,
  };
}

/** Parse + run, like `job-hunter app …` would. */
function run(...args: string[]): number {
  return runAppCommand(parseAppCommand(args), deps());
}

beforeEach(() => {
  repo = new Repository(":memory:", { today: () => "2026-11-11" });
  out = [];
  err = [];
  importCalls = [];
});
afterEach(() => repo.close());

describe("job-hunter app", () => {
  it("adds, lists, views, and reports stats", () => {
    expect(run("add", "Acme", "Staff", "Engineer", "--url", "https://a", "--salary", "200k")).toBe(
      0,
    );
    expect(out.at(-1)).toContain("Added #1: Acme — Staff Engineer");
    expect(run("add", "Globex", "Designer", "--date", "2026-10-01", "--json")).toBe(0);
    expect(JSON.parse(out.at(-1) ?? "")).toMatchObject({
      company: "Globex",
      dateApplied: "2026-10-01",
    });

    out = [];
    run("list");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("Acme — Staff Engineer");

    out = [];
    run("view", "acme");
    expect(out.join("\n")).toMatch(/Salary\s+200k/);
    expect(out.join("\n")).toContain("2026-11-11  Applied");

    out = [];
    run("list", "--json");
    expect(JSON.parse(out.join(""))).toHaveLength(2);

    out = [];
    run("stats");
    expect(out.join("\n")).toMatch(/applied\s+2/);
    expect(out.join("\n")).toMatch(/total\s+2/);
    out = [];
    run("stats", "--json");
    expect(JSON.parse(out.join(""))).toEqual({ applied: 2 });
  });

  it("hints on stderr when there is nothing to list or find", () => {
    run("list");
    run("list", "offered");
    run("search", "nothing");
    expect(out).toEqual([]);
    expect(err[0]).toContain("No applications yet");
    expect(err[1]).toContain("No matching applications");
    expect(err[2]).toContain('No applications match "nothing"');
  });

  it("moves status, adds notes, edits, and searches", () => {
    run("add", "Acme", "Eng");
    expect(run("status", "acme", "screened", "--date", "2026-11-12")).toBe(0);
    expect(out.at(-1)).toContain("applied → screened");
    run("status", "acme", "screened");
    expect(out.at(-1)).toContain("already screened");
    run("note", "acme", "Recruiter", "call");
    expect(out.at(-1)).toContain("Recruiter call");
    run("edit", "acme", "--role", "Senior Eng", "--recruiter", "Kim");
    expect(out.at(-1)).toContain("Updated #1: Acme — Senior Eng");

    out = [];
    run("search", "kim");
    expect(out[0]).toContain("Acme — Senior Eng");
    out = [];
    run("search", "kim", "--json");
    expect(JSON.parse(out.join(""))[0].notes.map((n: { content: string }) => n.content)).toEqual([
      "Applied",
      "Recruiter call", // dated today (11th), so it sorts before the status change on the 12th
      "Status changed from Applied to Screened",
    ]);
  });

  it("archives only closed applications, lists candidates, and restores", () => {
    run("add", "Acme", "Eng");
    expect(run("archive")).toBe(0);
    expect(err.at(-1)).toContain("Nothing to archive");
    expect(run("archive", "acme")).toBe(1);
    expect(err.at(-1)).toContain('cannot archive a "applied" application');

    run("status", "acme", "rejected");
    out = [];
    run("archive");
    expect(out[0]).toContain("Acme — Eng");
    expect(run("archive", "acme")).toBe(0);
    expect(out.at(-1)).toContain("Archived Acme");
    out = [];
    run("list", "--archived");
    expect(out[0]).toContain("(archived)");
    expect(run("unarchive", "acme")).toBe(0);
    expect(out.at(-1)).toContain("Restored Acme");
  });

  it("reports unknown or ambiguous selectors with exit code 1", () => {
    run("add", "Acme", "One");
    run("add", "Acme", "Two");
    expect(run("view", "globex")).toBe(1);
    expect(err.at(-1)).toContain('no application matches "globex"');
    expect(run("status", "acme", "offered")).toBe(1);
    expect(err.at(-1)).toContain("use the id");
    expect(run("status", "2", "offered")).toBe(0);
  });

  it("links a stored match on add, and un-marks it on remove", () => {
    repo.savePosting({
      id: "p1",
      company: "Acme",
      title: "Eng",
      url: "https://a/1",
      source: "lever",
      description: "",
      fetchedAt: new Date(),
    });
    repo.saveMatchResult("p1", { score: 90, matchedSkills: [], missingSkills: [] });

    run("add", "Acme", "Eng", "--posting", "p1");
    expect(repo.listScoredPostings(0, { onlyApplied: true })).toHaveLength(1);
    expect(repo.applications.list()).toHaveLength(1);

    expect(run("remove", "acme")).toBe(0);
    expect(repo.applications.list()).toHaveLength(0);
    expect(repo.listScoredPostings(0, { onlyApplied: true })).toHaveLength(0);
    expect(repo.listScoredPostings(0)).toHaveLength(1);
  });

  it("imports via the injected jt importer", () => {
    expect(run("import")).toBe(0);
    expect(run("import", "/x/jt.db")).toBe(0);
    expect(importCalls).toEqual([undefined, "/x/jt.db"]);
    expect(out.join("\n")).toContain("Imported 2 application(s) and 5 note(s) from /x/jt.db");
    expect(out.join("\n")).toContain("Skipped 1 already present");
  });

  it("rethrows unexpected errors instead of masking them", () => {
    const boom = deps({
      importJt: () => {
        throw new TypeError("bug");
      },
    });
    expect(() => runAppCommand({ sub: "import" }, boom)).toThrow("bug");
  });
});

describe("job-hunter app export", () => {
  it("prints jt-format markdown, writes a file, and handles empty sets", () => {
    run("export");
    expect(err.at(-1)).toContain("No applications to export");

    run(
      "add",
      "Acme",
      "Staff",
      "Eng",
      "--url",
      "https://a",
      "--source",
      "Referral",
      "--salary",
      "200k",
      "--recruiter",
      "Kim",
    );
    run("add", "Globex", "Designer");
    run("status", "globex", "rejected", "--date", "2026-11-12");
    run("archive", "globex");

    out = [];
    run("export");
    expect(out.join("\n")).toBe(
      [
        "# Job Applications",
        "",
        "> Exported from job-hunter.",
        "",
        "---",
        "",
        "## Acme | Staff Eng",
        "",
        "- **Status:** Applied",
        "- **Date Applied:** 2026-11-11",
        "- **URL:** https://a",
        "- **Source:** Referral",
        "- **Salary Range:** 200k",
        "- **Recruiter:** Kim",
        "- **Notes:**",
        "  - [2026-11-11] Applied",
      ].join("\n"),
    );

    const dir = mkdtempSync(join(tmpdir(), "jh-export-"));
    const file = join(dir, "archive.md");
    out = [];
    run("export", "--archived", "--file", file);
    expect(out[0]).toContain(`Exported 1 application(s) to ${file}`);
    const written = readFileSync(file, "utf8");
    expect(written).toContain("# Archived Applications");
    expect(written).toContain("- **Archived:** Yes");
    expect(written).toContain("  - [2026-11-12] Status changed from Applied to Rejected");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("job-hunter app docs", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jh-cli-docs-"));
    repo.close();
    repo = new Repository(":memory:", { today: () => "2026-11-11", docsDir: join(dir, "docs") });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(path: string, content = "x"): void {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }

  it("imports a job-hunt checkout, lists, and prints notes", () => {
    run("add", "Solace", "Eng");
    run("add", "Socket", "Eng");
    run("status", "socket", "rejected");
    run("archive", "socket");
    write("hunt/solace/prep.md", "# Solace prep");
    write("hunt/solace/shot.png", "png-bytes");
    write("hunt/archive/socket/CLAUDE.md", "# Socket");
    write("hunt/archive/loancrate/prep.md", "# Loancrate");

    out = [];
    expect(run("import-docs", join(dir, "hunt"))).toBe(0);
    expect(out.join("\n")).toContain("Solace: 2 document(s)");
    expect(out.join("\n")).toContain("Socket: 1 document(s)");
    expect(err.join("\n")).toContain("No application matches");
    expect(err.join("\n")).toContain("--into");

    out = [];
    run("import-docs", join(dir, "hunt"));
    expect(out.join("\n")).toContain("(2 already there)");

    out = [];
    run("docs", "solace");
    expect(out.join("\n")).toMatch(/note\s+prep\.md/);
    expect(out.join("\n")).toMatch(/file\s+shot\.png 9 B/);
    out = [];
    run("docs", "socket", "--json"); // archived applications resolve too
    expect(JSON.parse(out.join(""))).toMatchObject([{ name: "CLAUDE.md", kind: "note" }]);

    out = [];
    run("doc", "solace", "prep.md");
    expect(out).toEqual(["# Solace prep"]);
    run("doc", "solace", "shot.png");
    expect(out.at(-1)).toContain("isn't a text note");
    expect(run("doc", "solace", "nope.md")).toBe(1);
    expect(err.at(-1)).toContain('Solace has no document "nope.md"');
  });

  it("imports one folder --into a chosen application", () => {
    run("add", "LoanCrate Inc", "Eng");
    write("hunt/archive/loancrate/prep.md", "# Loancrate");
    out = [];
    expect(run("import-docs", join(dir, "hunt/archive/loancrate"), "--into", "loancrate")).toBe(0);
    expect(out[0]).toContain("LoanCrate Inc: 1 document(s)");
    expect(run("import-docs", join(dir, "hunt"), "--into", "nobody")).toBe(1);
  });

  it("reports empty states", () => {
    run("add", "Acme", "Eng");
    run("docs", "acme");
    expect(err.at(-1)).toContain("No documents for Acme");
    mkdirSync(join(dir, "empty"));
    run("import-docs", join(dir, "empty"));
    expect(err.at(-1)).toContain("No company folders found");
  });

  it("reports a stored file that went missing from disk", () => {
    run("add", "Acme", "Eng");
    write("ws/a.pdf", "%PDF");
    const app = repo.applications.resolve("acme");
    repo.documents.attachFile(app.id, join(dir, "ws/a.pdf"), "a.pdf");
    rmSync(join(dir, "docs"), { recursive: true });
    expect(run("doc", "acme", "a.pdf")).toBe(1);
    expect(err.at(-1)).toContain("missing from disk");
  });

  it("reports an ambiguous match among archived applications", () => {
    for (const role of ["One", "Two"]) {
      run("add", "Initech", role);
    }
    for (const id of ["1", "2"]) {
      run("status", id, "ghosted");
      run("archive", id);
    }
    expect(run("docs", "initech")).toBe(1);
    expect(err.at(-1)).toContain("use the id");
  });

  it("keeps an ambiguous active match an error instead of falling back to archived", () => {
    run("add", "Acme", "One");
    run("add", "Acme", "Two");
    expect(run("docs", "acme")).toBe(1);
    expect(err.at(-1)).toContain("use the id");
  });
});

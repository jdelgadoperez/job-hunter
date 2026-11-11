import { describe, expect, it } from "vitest";
import { parseCli } from "./parse";
import { AppParseError, appWantsJson, parseAppCommand } from "./parse-app";

describe("parseAppCommand", () => {
  it("parses add with a multi-word role and every option", () => {
    expect(
      parseAppCommand([
        "add",
        "Acme",
        "Senior",
        "Engineer",
        "--url",
        "https://a",
        "--source",
        "Referral",
        "--salary",
        "200k",
        "--recruiter",
        "Kim",
        "--date",
        "2026-11-01",
        "--posting",
        "p1",
        "--json",
      ]),
    ).toEqual({
      sub: "add",
      company: "Acme",
      role: "Senior Engineer",
      url: "https://a",
      source: "Referral",
      salaryRange: "200k",
      recruiter: "Kim",
      date: "2026-11-01",
      postingId: "p1",
      json: true,
    });
    expect(parseAppCommand(["add", "Acme", "Eng"])).toEqual({
      sub: "add",
      company: "Acme",
      role: "Eng",
      json: false,
    });
  });

  it("requires company and role for add, and a real date", () => {
    expect(() => parseAppCommand(["add", "Acme"])).toThrow("requires <company> <role>");
    expect(() => parseAppCommand(["add", "Acme", "Eng", "--date", "2026-02-31"])).toThrow(
      "invalid --date",
    );
  });

  it("parses list with an optional, case-insensitive status", () => {
    expect(parseAppCommand(["list"])).toEqual({ sub: "list", archived: false, json: false });
    expect(parseAppCommand(["list", "Screened", "--archived", "--json"])).toEqual({
      sub: "list",
      status: "screened",
      archived: true,
      json: true,
    });
    expect(() => parseAppCommand(["list", "hired"])).toThrow("unknown status: hired");
  });

  it("parses view, status, and note", () => {
    expect(parseAppCommand(["view", "Acme", "Labs", "--json"])).toEqual({
      sub: "view",
      selector: "Acme Labs",
      archived: false,
      json: true,
    });
    expect(parseAppCommand(["status", "acme", "offered", "--date", "2026-12-01"])).toEqual({
      sub: "status",
      selector: "acme",
      status: "offered",
      date: "2026-12-01",
    });
    expect(() => parseAppCommand(["status", "acme"])).toThrow("a status is required");
    expect(() => parseAppCommand(["status"])).toThrow("requires <company|id> <status>");
    expect(parseAppCommand(["note", "acme", "Phone", "screen", "booked"])).toEqual({
      sub: "note",
      selector: "acme",
      text: "Phone screen booked",
    });
    expect(() => parseAppCommand(["note", "acme"])).toThrow("requires <company|id> <text>");
    expect(() => parseAppCommand(["view"])).toThrow("requires <company|id>");
  });

  it("parses edit, keeping explicit empty values so they clear a field", () => {
    expect(
      parseAppCommand(["edit", "3", "--role", "Lead", "--recruiter", "", "--date", "2026-01-02"]),
    ).toEqual({
      sub: "edit",
      selector: "3",
      patch: { role: "Lead", recruiter: "", dateApplied: "2026-01-02" },
    });
    expect(() => parseAppCommand(["edit", "3"])).toThrow("needs at least one");
  });

  it("parses search, stats, archive, unarchive, remove, and import", () => {
    expect(parseAppCommand(["search", "remote", "rust"])).toEqual({
      sub: "search",
      term: "remote rust",
      json: false,
    });
    expect(() => parseAppCommand(["search"])).toThrow("requires <term>");
    expect(parseAppCommand(["stats", "--archived"])).toEqual({
      sub: "stats",
      archived: true,
      json: false,
    });
    expect(parseAppCommand(["archive"])).toEqual({ sub: "archive" });
    expect(parseAppCommand(["archive", "acme"])).toEqual({ sub: "archive", selector: "acme" });
    expect(parseAppCommand(["unarchive", "acme"])).toEqual({ sub: "unarchive", selector: "acme" });
    expect(parseAppCommand(["remove", "7"])).toEqual({ sub: "remove", selector: "7" });
    expect(() => parseAppCommand(["remove"])).toThrow("app remove requires");
    expect(parseAppCommand(["import"])).toEqual({ sub: "import" });
    expect(parseAppCommand(["import", "/x/jt.db"])).toEqual({ sub: "import", path: "/x/jt.db" });
  });

  it("parses docs, doc, and import-docs", () => {
    expect(parseAppCommand(["docs", "acme", "--json"])).toEqual({
      sub: "docs",
      selector: "acme",
      json: true,
    });
    expect(parseAppCommand(["doc", "acme", "sys-design/notes.md"])).toEqual({
      sub: "doc",
      selector: "acme",
      name: "sys-design/notes.md",
    });
    expect(parseAppCommand(["import-docs", "~/job-hunt"])).toEqual({
      sub: "import-docs",
      path: "~/job-hunt",
      overwrite: false,
    });
    expect(
      parseAppCommand(["import-docs", "/x/socket", "--into", "socket", "--overwrite"]),
    ).toEqual({ sub: "import-docs", path: "/x/socket", into: "socket", overwrite: true });
    expect(() => parseAppCommand(["docs"])).toThrow("app docs requires");
    expect(() => parseAppCommand(["doc", "acme"])).toThrow("app doc requires");
    expect(() => parseAppCommand(["import-docs"])).toThrow("requires <folder>");
  });

  it("rejects unknown subcommands and flags with an AppParseError", () => {
    expect(() => parseAppCommand([])).toThrow("app requires a subcommand");
    expect(() => parseAppCommand(["frob"])).toThrow("unknown app subcommand: frob");
    expect(() => parseAppCommand(["list", "--bogus"])).toThrow(AppParseError);
  });

  it("reports whether JSON output was requested", () => {
    expect(appWantsJson({ sub: "list", archived: false, json: true })).toBe(true);
    expect(appWantsJson({ sub: "archive" })).toBe(false);
  });
});

describe("parseCli app routing", () => {
  it("routes app commands and turns parse errors into app help", () => {
    expect(parseCli(["app", "stats"])).toEqual({
      kind: "app",
      app: { sub: "stats", archived: false, json: false },
    });
    expect(parseCli(["app", "frob"])).toEqual({
      kind: "help",
      error: "unknown app subcommand: frob",
      topic: "app",
    });
  });

  it("treats bare help/version words in free text as content, not flags", () => {
    expect(parseCli(["app", "note", "acme", "need", "help", "with", "version"])).toEqual({
      kind: "app",
      app: { sub: "note", selector: "acme", text: "need help with version" },
    });
    expect(parseCli(["app", "help"])).toEqual({ kind: "help", topic: "app" });
    expect(parseCli(["app", "list", "--help"])).toEqual({ kind: "help", topic: "app" });
    expect(parseCli(["help", "app"])).toEqual({ kind: "help", topic: "app" });
  });
});

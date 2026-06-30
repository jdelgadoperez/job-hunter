import { describe, expect, it } from "vitest";
import { DEFAULT_MIN_HEURISTIC, DEFAULT_SCORE_LIMIT, parseCli } from "./parse";

describe("parseCli", () => {
  it("parses scan", () => {
    expect(parseCli(["scan"])).toEqual({ kind: "scan" });
  });

  it("parses list with and without --min-score (defaulting to 50)", () => {
    expect(parseCli(["list"])).toEqual({ kind: "list", minScore: 50, remoteOnly: false });
    expect(parseCli(["list", "--min-score", "70"])).toEqual({
      kind: "list",
      minScore: 70,
      remoteOnly: false,
    });
    // An explicit 0 is honored (show everything).
    expect(parseCli(["list", "--min-score", "0"])).toEqual({
      kind: "list",
      minScore: 0,
      remoteOnly: false,
    });
    // Non-numeric falls back to the default rather than NaN.
    expect(parseCli(["list", "--min-score", "abc"])).toEqual({
      kind: "list",
      minScore: 50,
      remoteOnly: false,
    });
  });

  it("parses list --remote-only", () => {
    expect(parseCli(["list", "--remote-only"])).toEqual({
      kind: "list",
      minScore: 50,
      remoteOnly: true,
    });
    expect(parseCli(["list", "--min-score", "60", "--remote-only"])).toEqual({
      kind: "list",
      minScore: 60,
      remoteOnly: true,
    });
  });

  it("parses serve with defaults, --port, --no-open, and --refresh-hours", () => {
    expect(parseCli(["serve"])).toEqual({ kind: "serve", open: true });
    expect(parseCli(["serve", "--port", "8080"])).toEqual({
      kind: "serve",
      port: 8080,
      open: true,
    });
    expect(parseCli(["serve", "--no-open"])).toEqual({ kind: "serve", open: false });
    expect(parseCli(["serve", "--refresh-hours", "12"])).toEqual({
      kind: "serve",
      open: true,
      refreshHours: 12,
    });
    // 0 is valid (disables the scheduler).
    expect(parseCli(["serve", "--refresh-hours", "0"])).toEqual({
      kind: "serve",
      open: true,
      refreshHours: 0,
    });
    // Out-of-range / non-numeric values are rejected.
    expect(parseCli(["serve", "--port", "abc"])).toMatchObject({
      kind: "help",
      error: expect.any(String),
    });
    expect(parseCli(["serve", "--port", "70000"])).toMatchObject({
      kind: "help",
      error: expect.any(String),
    });
    expect(parseCli(["serve", "--refresh-hours", "nope"])).toMatchObject({
      kind: "help",
      error: expect.any(String),
    });
  });

  it("parses profile with a path, else help", () => {
    expect(parseCli(["profile", "/tmp/cv.pdf"])).toEqual({
      kind: "profile",
      resumePath: "/tmp/cv.pdf",
    });
    expect(parseCli(["profile"])).toMatchObject({ kind: "help", error: expect.any(String) });
  });

  it("parses track subcommands", () => {
    expect(parseCli(["track", "add", "https://x.com/careers", "--name", "X Co"])).toEqual({
      kind: "track-add",
      url: "https://x.com/careers",
      name: "X Co",
    });
    expect(parseCli(["track", "add", "https://x.com/careers"])).toEqual({
      kind: "track-add",
      url: "https://x.com/careers",
    });
    expect(parseCli(["track", "list"])).toEqual({ kind: "track-list" });
    expect(parseCli(["track", "remove", "https://x.com/careers"])).toEqual({
      kind: "track-remove",
      url: "https://x.com/careers",
    });
    expect(parseCli(["track", "add"])).toMatchObject({ kind: "help", error: expect.any(String) });
    expect(parseCli(["track", "bogus"])).toMatchObject({ kind: "help", error: expect.any(String) });
  });

  it("returns help for no command or an unknown command", () => {
    expect(parseCli([])).toEqual({ kind: "help" });
    expect(parseCli(["frobnicate"])).toMatchObject({ kind: "help", error: expect.any(String) });
  });

  it("treats help/version flags as commands wherever they appear", () => {
    expect(parseCli(["--help"])).toEqual({ kind: "help" });
    expect(parseCli(["-h"])).toEqual({ kind: "help" });
    expect(parseCli(["help"])).toEqual({ kind: "help" });
    expect(parseCli(["--version"])).toEqual({ kind: "version" });
    expect(parseCli(["-v"])).toEqual({ kind: "version" });
    expect(parseCli(["version"])).toEqual({ kind: "version" });
  });

  it("scopes --help to a command topic (so `scan --help` documents scan)", () => {
    expect(parseCli(["scan", "--help"])).toEqual({ kind: "help", topic: "scan" });
    expect(parseCli(["track", "-h"])).toEqual({ kind: "help", topic: "track" });
    // `help <topic>` works too, and an unknown topic falls back to the global overview.
    expect(parseCli(["help", "list"])).toEqual({ kind: "help", topic: "list" });
    expect(parseCli(["help", "bogus"])).toEqual({ kind: "help" });
  });
});

describe("score command", () => {
  it("defaults min-heuristic and limit", () => {
    expect(parseCli(["score"])).toEqual({
      kind: "score",
      minHeuristic: DEFAULT_MIN_HEURISTIC,
      limit: DEFAULT_SCORE_LIMIT,
      rescore: false,
      dryRun: false,
    });
  });

  it("parses the knobs and flags", () => {
    expect(
      parseCli([
        "score",
        "--min-heuristic",
        "40",
        "--limit",
        "25",
        "--rescore",
        "--dry-run",
        "--remote",
      ]),
    ).toEqual({
      kind: "score",
      minHeuristic: 40,
      limit: 25,
      remoteOnly: true,
      rescore: true,
      dryRun: true,
    });
  });

  it("parses --no-remote as an explicit override", () => {
    const cmd = parseCli(["score", "--no-remote"]);
    expect(cmd).toMatchObject({ kind: "score", remoteOnly: false });
  });
});

describe("config remote command", () => {
  it("parses on/off", () => {
    expect(parseCli(["config", "remote", "on"])).toEqual({
      kind: "config-remote",
      on: true,
    });
    expect(parseCli(["config", "remote", "off"])).toEqual({
      kind: "config-remote",
      on: false,
    });
  });

  it("errors on a bad value", () => {
    expect(parseCli(["config", "remote", "maybe"]).kind).toBe("help");
  });
});

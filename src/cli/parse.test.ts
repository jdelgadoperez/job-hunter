import { describe, expect, it } from "vitest";
import { parseCli } from "./parse";

describe("parseCli", () => {
  it("parses scan", () => {
    expect(parseCli(["scan"])).toEqual({ kind: "scan" });
  });

  it("parses list with and without --min-score", () => {
    expect(parseCli(["list"])).toEqual({ kind: "list", minScore: 0 });
    expect(parseCli(["list", "--min-score", "70"])).toEqual({ kind: "list", minScore: 70 });
    // Non-numeric falls back to 0 rather than NaN.
    expect(parseCli(["list", "--min-score", "abc"])).toEqual({ kind: "list", minScore: 0 });
  });

  it("parses serve with defaults, --port, and --no-open", () => {
    expect(parseCli(["serve"])).toEqual({ kind: "serve", open: true });
    expect(parseCli(["serve", "--port", "8080"])).toEqual({
      kind: "serve",
      port: 8080,
      open: true,
    });
    expect(parseCli(["serve", "--no-open"])).toEqual({ kind: "serve", open: false });
    // Out-of-range / non-integer ports are rejected.
    expect(parseCli(["serve", "--port", "abc"])).toMatchObject({
      kind: "help",
      error: expect.any(String),
    });
    expect(parseCli(["serve", "--port", "70000"])).toMatchObject({
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
});

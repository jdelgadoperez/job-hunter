import { describe, expect, it } from "vitest";
import { COMMAND_NAMES, COMMANDS, renderHelp } from "./help";

describe("renderHelp", () => {
  it("renders the global overview with every command listed", () => {
    const out = renderHelp();
    expect(out).toContain("job-hunter");
    expect(out).toContain("COMMANDS");
    for (const cmd of COMMANDS) expect(out).toContain(cmd.name);
    // Top-level flags are documented.
    expect(out).toContain("--help");
    expect(out).toContain("--version");
  });

  it("shows the bow-and-arrow banner on the overview but not command pages", () => {
    expect(renderHelp()).toContain(">>------------------>");
    expect(renderHelp("list")).not.toContain(">>------------------>");
  });

  it("renders a command-specific page for a known topic", () => {
    const out = renderHelp("list");
    expect(out).toContain("job-hunter list");
    expect(out).toContain("--min-score");
    expect(out).toContain("EXAMPLES");
  });

  it("shows subcommands for track", () => {
    const out = renderHelp("track");
    expect(out).toContain("SUBCOMMANDS");
    expect(out).toContain("add <url>");
    expect(out).toContain("remove <url>");
  });

  it("falls back to the global overview for an unknown topic", () => {
    expect(renderHelp("nope")).toBe(renderHelp());
  });

  it("exposes every command name as a help topic", () => {
    expect(COMMAND_NAMES).toEqual(
      new Set(["scan", "score", "config", "list", "serve", "profile", "track"]),
    );
  });

  it("documents the score and config commands", () => {
    const help = renderHelp();
    expect(help).toContain("score");
    expect(help).toContain("config");
  });

  it("scan help no longer claims to score", () => {
    const scanHelp = renderHelp("scan");
    expect(scanHelp.toLowerCase()).not.toContain("scores every posting");
  });
});

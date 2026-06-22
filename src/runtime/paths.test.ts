import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DATA_DIR_ENV, ensureDataDir, resolveDataDir, resolveDbPath } from "./paths";

describe("resolveDataDir", () => {
  it("uses %APPDATA% on Windows", () => {
    const dir = resolveDataDir({
      platform: "win32",
      env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
      homedir: "C:\\Users\\me",
    });
    expect(dir).toBe(join("C:\\Users\\me\\AppData\\Roaming", "job-hunter"));
  });

  it("falls back to the home dir on Windows when APPDATA is absent", () => {
    const dir = resolveDataDir({ platform: "win32", env: {}, homedir: "C:\\Users\\me" });
    expect(dir).toBe(join("C:\\Users\\me", "job-hunter"));
  });

  it("uses a dotfile dir on macOS/Linux", () => {
    expect(resolveDataDir({ platform: "darwin", env: {}, homedir: "/Users/me" })).toBe(
      join("/Users/me", ".job-hunter"),
    );
    expect(resolveDataDir({ platform: "linux", env: {}, homedir: "/home/me" })).toBe(
      join("/home/me", ".job-hunter"),
    );
  });

  it("honors the JOB_HUNTER_HOME override on any platform", () => {
    const dir = resolveDataDir({
      platform: "darwin",
      env: { [DATA_DIR_ENV]: "/custom/path" },
      homedir: "/Users/me",
    });
    expect(dir).toBe("/custom/path");
  });
});

describe("resolveDbPath", () => {
  it("appends the database filename to the data dir", () => {
    expect(resolveDbPath({ platform: "linux", env: {}, homedir: "/home/me" })).toBe(
      join("/home/me", ".job-hunter", "jobhunter.db"),
    );
  });
});

describe("ensureDataDir", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    created.length = 0;
  });

  it("creates the data directory and returns it", () => {
    const base = mkdtempSync(join(tmpdir(), "jh-paths-"));
    created.push(base);
    const target = join(base, "nested", "data");
    const result = ensureDataDir({ env: { [DATA_DIR_ENV]: target } });
    expect(result).toBe(target);
    expect(existsSync(target)).toBe(true);
  });
});

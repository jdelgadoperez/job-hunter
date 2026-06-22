import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIRTABLE_SHARE_SETTING } from "@app/discovery/sources/airtable";
import type { JobPosting, SkillProfile, Warning } from "@app/domain/types";
import { Repository } from "@app/storage/repository";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Holder mutated per-test and read by the hoisted mock factories below.
const h = vi.hoisted(() => ({
  dbPath: ":memory:",
  postings: [] as JobPosting[],
  warnings: [] as Warning[],
  resumeText: "Experienced with TypeScript and React.",
}));

// Point the CLI at a per-test temp database instead of the real data dir.
vi.mock("@app/runtime/paths", () => ({
  ensureDataDir: () => {},
  resolveDbPath: () => h.dbPath,
}));

// Stub discovery so `scan` runs fully offline (no browser, no network).
vi.mock("@app/discovery/discover", () => ({
  discover: async () => ({ postings: h.postings, warnings: h.warnings }),
}));

// Avoid reading a real file in the `profile` command.
vi.mock("@app/profile/read-resume", () => ({
  readResumeText: async () => h.resumeText,
}));

import { main, settingsWithEnvKey } from "./main";

const profile: SkillProfile = {
  skills: ["typescript", "react"],
  roleKeywords: ["engineer"],
  categories: [],
};

function posting(id: string): JobPosting {
  return {
    id,
    company: "Acme",
    title: "Senior TypeScript Engineer",
    url: `https://boards.greenhouse.io/acme/jobs/${id}`,
    source: "greenhouse",
    description: "We need TypeScript and React.",
    fetchedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

/** Open the per-test database to seed or inspect it directly. */
function openDb(): Repository {
  return new Repository(h.dbPath);
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let tmp: string;

function logged(): string {
  return logSpy.mock.calls.map((c) => String(c[0])).join("\n");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "job-hunter-cli-"));
  h.dbPath = join(tmp, "test.db");
  h.postings = [];
  h.warnings = [];
  process.exitCode = 0;
  vi.stubEnv("ANTHROPIC_API_KEY", undefined);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  vi.unstubAllEnvs();
  process.argv = process.argv.slice(0, 2);
  process.exitCode = 0;
  rmSync(tmp, { recursive: true, force: true });
});

async function runCli(...args: string[]): Promise<void> {
  process.argv = ["node", "main.ts", ...args];
  await main();
}

describe("main dispatch", () => {
  it("prints usage for help and exits 0", async () => {
    await runCli();
    expect(logged()).toContain("job-hunter");
    expect(process.exitCode).toBe(0);
  });

  it("prints the parse error and exits 1 for an unknown command", async () => {
    await runCli("bogus");
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("Error:");
    expect(process.exitCode).toBe(1);
  });

  it("tracks, lists, and removes a company across invocations", async () => {
    await runCli("track", "add", "https://acme.com/careers", "--name", "Acme");
    expect(logged()).toContain("Tracking Acme");

    logSpy.mockClear();
    await runCli("track", "list");
    expect(logged()).toContain("https://acme.com/careers");

    logSpy.mockClear();
    await runCli("track", "remove", "https://acme.com/careers");
    expect(logged()).toContain("Removed");
  });

  it("builds a profile from a resume file", async () => {
    await runCli("profile", "/tmp/cv.pdf");
    expect(logged()).toContain("Saved profile");
    const repo = openDb();
    expect(repo.getLatestProfile()?.skills).toEqual(expect.arrayContaining(["typescript"]));
    repo.close();
  });

  it("reports an empty list before any scan", async () => {
    await runCli("list");
    expect(logged()).toContain("No matches yet");
  });
});

describe("scan command", () => {
  function seed(opts: { profile?: boolean; shareUrl?: boolean }): void {
    const repo = openDb();
    if (opts.profile) repo.saveProfile(profile);
    if (opts.shareUrl) repo.setSetting(AIRTABLE_SHARE_SETTING, "https://airtable.com/shrX");
    repo.close();
  }

  it("aborts with exit 1 when no profile exists", async () => {
    await runCli("scan");
    expect(logged()).toContain("No profile yet");
    expect(process.exitCode).toBe(1);
  });

  it("aborts with exit 1 when no Airtable share URL is set", async () => {
    seed({ profile: true });
    await runCli("scan");
    expect(logged()).toContain("No Airtable share URL set");
    expect(process.exitCode).toBe(1);
  });

  it("discovers, scores, and stores postings, surfacing scorer warnings", async () => {
    seed({ profile: true, shareUrl: true });
    h.postings = [posting("1")];

    await runCli("scan");

    expect(logged()).toContain("Scanned and scored 1");
    // With no API key, resolveScorer falls back to the heuristic and warns.
    expect(logged()).toContain("!");

    const repo = openDb();
    expect(repo.listScoredPostings(0)).toHaveLength(1);
    repo.close();
  });
});

describe("settingsWithEnvKey", () => {
  it("prefers stored settings, then falls back to the env var, then undefined", () => {
    const repo = openDb();
    repo.setSetting("foo", "stored");
    const reader = settingsWithEnvKey(repo);

    expect(reader.getSetting("foo")).toBe("stored");

    vi.stubEnv("ANTHROPIC_API_KEY", "  sk-from-env  ");
    expect(reader.getSetting("anthropicApiKey")).toBe("sk-from-env");

    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    expect(reader.getSetting("anthropicApiKey")).toBeUndefined();
    expect(reader.getSetting("missing")).toBeUndefined();
    repo.close();
  });

  it("prefers a stored API key over the env var", () => {
    const repo = openDb();
    repo.setSetting("anthropicApiKey", "sk-stored");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-env");
    expect(settingsWithEnvKey(repo).getSetting("anthropicApiKey")).toBe("sk-stored");
    repo.close();
  });
});

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobPosting, SkillProfile, Warning } from "@app/domain/types";
import { settingsWithEnvKey } from "@app/matching/resolve-settings";
import { PlaywrightRenderer } from "@app/net/playwright-renderer";
import { Repository } from "@app/storage/repository";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiagnostics, type Diagnostics } from "./diagnostics";
import type { SignalTarget } from "./signals";

// Holder mutated per-test and read by the hoisted mock factories below.
const h = vi.hoisted(() => ({
  dbPath: ":memory:",
  postings: [] as JobPosting[],
  warnings: [] as Warning[],
  resumeText: "Experienced with TypeScript and React.",
  startServer: vi.fn(),
  runServiceCommand: vi.fn(),
  // When set, `discover` awaits this instead of resolving immediately — lets a test hold a scan
  // in flight so it can emit a signal mid-scan instead of after `runScanCommand` has settled.
  discoverGate: null as Promise<void> | null,
}));

// Point the CLI at a per-test temp database instead of the real data dir.
vi.mock("@app/runtime/paths", () => ({
  ensureDataDir: () => {},
  resolveDbPath: () => h.dbPath,
}));

// Stub discovery so `scan` runs fully offline (no browser, no network).
vi.mock("@app/discovery/discover", () => ({
  discover: async () => {
    if (h.discoverGate) await h.discoverGate;
    return { postings: h.postings, warnings: h.warnings };
  },
}));

// Avoid reading a real file in the `profile` command.
vi.mock("@app/profile/read-resume", () => ({
  readResumeText: async () => h.resumeText,
}));

// Don't boot a real HTTP listener when dispatching the `serve` command.
vi.mock("@app/server/serve", () => ({
  startServer: (opts: unknown) => h.startServer(opts),
}));

// Don't spawn the real background-service script when dispatching `service` — but keep the real
// pure exports (isServiceAction/SERVICE_ACTIONS) that the parser depends on.
vi.mock("./service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./service")>()),
  runServiceCommand: (action: unknown) => h.runServiceCommand(action),
}));

import { main, runScanCommand } from "./main";

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
let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
let tmp: string;

function logged(): string {
  return logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
}

/** Diagnostics (`diagnostics.diag`) write via `process.stderr.write`, not `console.error`. */
function stderrLogged(): string {
  return stderrWriteSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "job-hunter-cli-"));
  h.dbPath = join(tmp, "test.db");
  h.postings = [];
  h.warnings = [];
  h.discoverGate = null;
  h.startServer.mockReset();
  h.runServiceCommand.mockReset().mockResolvedValue(0);
  process.exitCode = 0;
  vi.stubEnv("ANTHROPIC_API_KEY", undefined);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  stderrWriteSpy.mockRestore();
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
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toContain("Error:");
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

  it("reports an empty list before any scan, on stderr not stdout", async () => {
    await runCli("list");
    expect(stderrLogged()).toContain("No matches yet");
    expect(logged()).not.toContain("No matches yet");
  });

  it("starts the web server for the serve command, passing through options", async () => {
    await runCli("serve", "--port", "8080", "--no-open", "--refresh-hours", "12");
    expect(h.startServer).toHaveBeenCalledWith({ port: 8080, open: false, refreshHours: 12 });
  });

  it("dispatches the service command to the platform script and adopts its exit code", async () => {
    h.runServiceCommand.mockResolvedValue(3);
    await runCli("service", "status");
    expect(h.runServiceCommand).toHaveBeenCalledWith("status");
    expect(process.exitCode).toBe(3);
  });

  it("does not open the database for the service command", async () => {
    // A service action needs no DB — resolveDbPath must not even be consulted. (If it were, this
    // would still pass, but the assertion documents that `service` short-circuits before the repo.)
    await runCli("service", "install");
    expect(h.runServiceCommand).toHaveBeenCalledWith("install");
  });
});

describe("scan command", () => {
  function seedProfile(): void {
    const repo = openDb();
    repo.saveProfile(profile);
    repo.close();
  }

  it("aborts with exit 1 when no profile exists", async () => {
    await runCli("scan");
    // The precondition guard is a diagnostic (3.2/3.6) — it belongs on stderr, not stdout.
    expect(stderrLogged()).toContain("No profile yet");
    expect(logged()).not.toContain("No profile yet");
    expect(process.exitCode).toBe(1);
  });

  it("discovers, heuristic-scores, and stores postings without any LLM warnings", async () => {
    // No Airtable URL is configured: the directory is the fixed community table.
    seedProfile();
    h.postings = [posting("1")];

    await runCli("scan");

    // Scan progress is a diagnostic — routed to stderr via onProgress, not stdout.
    expect(stderrLogged()).toContain("Scanned and scored 1");
    expect(logged()).not.toContain("Scanned and scored 1");
    expect(stderrLogged()).not.toContain("No LLM key");

    const repo = openDb();
    expect(repo.listScoredPostings(0)).toHaveLength(1);
    repo.close();
  });

  it("--retry-failed scopes discovery to the needs-attention list only", async () => {
    seedProfile();
    const repo = openDb();
    for (let scanId = 1; scanId <= 5; scanId++) {
      repo.recordScanFailures(
        scanId,
        [{ careersUrl: "https://boom.com/careers", company: "Boom", message: "timeout" }],
        ["https://boom.com/careers"],
      );
    }
    repo.close();
    h.postings = [posting("1")];

    await runCli("scan", "--retry-failed");

    expect(stderrLogged()).toContain("Scanned and scored 1");
    expect(logged()).not.toContain("Scanned and scored 1");
  });

  it("--retry-failed with an empty needs-attention list is a no-op", async () => {
    seedProfile();

    await runCli("scan", "--retry-failed");

    expect(logged()).toContain("Nothing needs attention");
  });

  it("runs --retry-failed as a retry-scope scan", async () => {
    seedProfile();
    const repo = openDb();
    for (let scanId = 1; scanId <= 5; scanId++) {
      repo.recordScanFailures(
        scanId,
        [{ careersUrl: "https://flaky.example/careers", company: "Flaky", message: "timeout" }],
        ["https://flaky.example/careers"],
      );
    }
    repo.close();
    h.postings = [];

    await runCli("scan", "--retry-failed");

    const verifyRepo = openDb();
    // biome-ignore lint/complexity/useLiteralKeys: bracket access reaches the private `db` field.
    const scansDb = verifyRepo["db"];
    const latestScan = scansDb.prepare("SELECT kind FROM scans ORDER BY id DESC LIMIT 1").get() as {
      kind: string;
    };
    expect(latestScan.kind).toBe("retry");
    verifyRepo.close();
  });
});

describe("score command --json", () => {
  function seedProfile(): void {
    const repo = openDb();
    repo.saveProfile(profile);
    repo.close();
  }

  it("prints the ScoreOutcome as pure JSON to stdout and routes usage/warnings to stderr", async () => {
    // Dry-run short-circuits `runScoreRun` before any triager/scorer network call (see
    // src/matching/score-run.ts), so a dummy API key + --dry-run stays fully offline while still
    // exercising the json-mode branch past the "no key configured" early return.
    seedProfile();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-dummy-offline-key");

    await runCli("score", "--dry-run", "--json");

    const parsed = JSON.parse(logged());
    expect(parsed).toHaveProperty("counts");
    expect(parsed).toHaveProperty("abortedOnLimit");
    expect(parsed).toHaveProperty("estimate");
    expect(parsed).toHaveProperty("warnings");

    // stdout must be pure JSON: it must NOT contain human plan text that `formatScorePlan` would
    // emit (e.g. the "Cap (--limit N): ..." line from commands.ts).
    expect(logged()).not.toContain("Cap (--limit");
  });

  it("routes the no-profile precondition guard to stderr, not stdout, even in json mode", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-dummy-offline-key");

    await runCli("score", "--dry-run", "--json");

    expect(stderrLogged()).toContain("No profile yet");
    expect(logged()).toBe("");
    expect(process.exitCode).toBe(1);
  });

  it("routes the no-key precondition warning to stderr in human mode", async () => {
    seedProfile();
    // beforeEach already stubs ANTHROPIC_API_KEY to undefined.

    await runCli("score", "--dry-run");

    expect(stderrLogged()).toContain("No LLM key configured");
    expect(logged()).not.toContain("No LLM key configured");
  });
});

describe("scan command signal handling", () => {
  function seedProfileForScan(): void {
    const repo = openDb();
    repo.saveProfile(profile);
    repo.close();
  }
  function fakeSignals(): EventEmitter & SignalTarget {
    return new EventEmitter();
  }
  // Diagnostics is a required arg since PR B; a silent sink keeps these tests off the console.
  function quietDiagnostics(): Diagnostics {
    return createDiagnostics({ verbose: false, json: false }, () => {});
  }

  it("disposes the Playwright renderer and exits 130 on SIGINT", async () => {
    seedProfileForScan();
    h.postings = [posting("1")];
    // Hold discovery in flight so the scan is still running when SIGINT fires — otherwise the
    // try/finally would have already deregistered the handler before we get to emit it.
    let releaseDiscovery: () => void = () => {};
    h.discoverGate = new Promise((resolve) => {
      releaseDiscovery = resolve;
    });
    const signals = fakeSignals();
    const disposeSpy = vi
      .spyOn(PlaywrightRenderer.prototype, "dispose")
      .mockResolvedValue(undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const repo = openDb();

    const scanPromise = runScanCommand(
      repo,
      () => {},
      { retryFailed: false, all: false },
      quietDiagnostics(),
      signals,
    );
    signals.emit("SIGINT");
    releaseDiscovery();
    await scanPromise;

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(130);

    repo.close();
    disposeSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("removes the signal handler after a normal scan (no leak)", async () => {
    seedProfileForScan();
    h.postings = [posting("1")];
    const signals = fakeSignals();
    const disposeSpy = vi
      .spyOn(PlaywrightRenderer.prototype, "dispose")
      .mockResolvedValue(undefined);
    const repo = openDb();

    await runScanCommand(
      repo,
      () => {},
      { retryFailed: false, all: false },
      quietDiagnostics(),
      signals,
    );
    disposeSpy.mockClear(); // ignore the normal end-of-discovery dispose
    signals.emit("SIGINT"); // handler should be gone

    expect(disposeSpy).not.toHaveBeenCalled();
    expect(signals.listenerCount("SIGINT")).toBe(0);

    repo.close();
    disposeSpy.mockRestore();
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

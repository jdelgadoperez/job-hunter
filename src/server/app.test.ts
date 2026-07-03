import { ANTHROPIC_KEY_SETTING } from "@app/matching/settings-keys";
import { buildProfile } from "@app/profile/build-profile";
import { Repository } from "@app/storage/repository";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, isLoopbackHost } from "./app";
import { ScanJobManager } from "./scan-job";
import { ScoreJobManager, type ScoreResult } from "./score-job";

import { NoApiKeyError } from "./score-runner";
import type { ServerDeps } from "./types";

/** `Response.json()` is typed `unknown`; this narrows it at the call site without `any`. */
async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** A canned deep-score outcome for the fake runner/preview in tests. */
function fakeScoreResult(overrides: Partial<ScoreResult> = {}): ScoreResult {
  return {
    counts: {
      inDb: 0,
      afterRemote: 0,
      afterHeuristic: 0,
      afterCap: 0,
      alreadyScoredSkipped: 0,
      triageTitles: 0,
      deepScored: 0,
      remotePenalized: 0,
      locationPenalized: 0,
    },
    estimate: {
      triageTitles: 0,
      triageBatches: 0,
      deepScores: 0,
      triageUsd: 0,
      deepScoreUsd: 0,
      totalUsd: 0,
    },
    warnings: [],
    abortedOnLimit: false,
    ...overrides,
  };
}

let repo: Repository;

function makeApp(overrides: Partial<ServerDeps> = {}) {
  const deps: ServerDeps = {
    repo,
    jobs: new ScanJobManager(),
    runScanForScope: () => async () => ({ count: 0, warnings: [] }),
    retryFailedScan: async () => ({ count: 0, warnings: [] }),
    scoreJobs: new ScoreJobManager(),
    createScoreRun: () => async () => fakeScoreResult(),
    previewScore: async () => fakeScoreResult(),
    buildProfileFromText: (text) => buildProfile({ resumeText: text }),
    getUpdateStatus: async () => ({ version: "0.1.0", behind: 0, updateAvailable: false }),
    ...overrides,
  };
  return createApp(deps);
}

beforeEach(() => {
  repo = new Repository(":memory:");
});

afterEach(() => {
  repo.close();
});

describe("GET /api/health", () => {
  it("reports ok", async () => {
    const res = await makeApp().request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("isLoopbackHost (DNS-rebinding guard)", () => {
  it("accepts loopback hosts, with or without a port", () => {
    for (const host of [
      "localhost",
      "localhost:4317",
      "127.0.0.1",
      "127.0.0.1:4317",
      "[::1]:4317",
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    // A missing Host header (e.g. curl/HTTP-1.0) is allowed — only browsers send one.
    expect(isLoopbackHost(undefined)).toBe(true);
  });

  it("rejects non-loopback hosts (the DNS-rebinding signature)", () => {
    for (const host of ["evil.example.com", "192.168.1.5:4317", "0.0.0.0:4317", "10.0.0.1"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("host allowlist middleware", () => {
  it("rejects a non-loopback Host header with 403", async () => {
    // app.request strips a `host` init header, so drive the matching Request through app.fetch.
    const req = new Request("http://evil.example.com/api/health");
    Object.defineProperty(req, "headers", {
      value: new Headers({ host: "evil.example.com" }),
    });
    const res = await makeApp().fetch(req);
    expect(res.status).toBe(403);
    expect(await json<{ error: string }>(res)).toEqual({ error: "forbidden host" });
  });
});

describe("GET /api/version", () => {
  it("returns the injected version + update status", async () => {
    const app = makeApp({
      getUpdateStatus: async () => ({ version: "9.9.9", behind: 4, updateAvailable: true }),
    });
    expect(await json(await app.request("/api/version"))).toEqual({
      version: "9.9.9",
      behind: 4,
      updateAvailable: true,
    });
  });
});

describe("GET /api/matches", () => {
  function seedMatch(id: string, score: number): void {
    repo.savePosting({
      id,
      company: "Acme",
      title: "Engineer",
      url: `https://acme.com/${id}`,
      source: "greenhouse",
      description: "TypeScript",
      fetchedAt: new Date("2026-01-01T00:00:00Z"),
    });
    repo.saveMatchResult(id, { score, matchedSkills: ["typescript"], missingSkills: [] });
  }

  it("returns scored postings, honoring minScore", async () => {
    seedMatch("a", 90);
    seedMatch("b", 40);
    const app = makeApp();

    expect(await json(await app.request("/api/matches"))).toHaveLength(2);

    const filtered = await json<{ posting: { id: string } }[]>(
      await app.request("/api/matches?minScore=50"),
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.posting.id).toBe("a");
  });

  it("falls back to 0 for a non-numeric minScore", async () => {
    seedMatch("a", 10);
    const res = await makeApp().request("/api/matches?minScore=oops");
    expect(await json(res)).toHaveLength(1);
  });

  it("saves/dismisses a match and honors the include filters", async () => {
    seedMatch("a", 90);
    const app = makeApp();

    // Dismiss it → drops from the default list, returns with includeDismissed.
    const put = await app.request("/api/matches/a/action", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "dismissed" }),
    });
    expect(put.status).toBe(200);
    expect(await json(await app.request("/api/matches"))).toHaveLength(0);

    const withDismissed = await json<{ action: string | null }[]>(
      await app.request("/api/matches?includeDismissed=true"),
    );
    expect(withDismissed[0]?.action).toBe("dismissed");

    // Clear it → back in the default list.
    const del = await app.request("/api/matches/a/action", { method: "DELETE" });
    expect(await json<{ removed: boolean }>(del)).toEqual({ removed: true });
    expect(await json(await app.request("/api/matches"))).toHaveLength(1);
  });

  it("rejects an invalid action", async () => {
    const res = await makeApp().request("/api/matches/a/action", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "bogus" }),
    });
    expect(res.status).toBe(400);
  });

  it("remoteOnly=true returns only resolved-remote postings", async () => {
    repo.savePosting({
      id: "rem1",
      company: "Co",
      title: "Remote Job",
      url: "https://co.com/rem1",
      source: "lever",
      description: "desc",
      remote: true,
      fetchedAt: new Date("2026-01-01T00:00:00Z"),
    });
    repo.savePosting({
      id: "ons1",
      company: "Co",
      title: "Office Job",
      url: "https://co.com/ons1",
      source: "lever",
      description: "desc",
      remote: false,
      fetchedAt: new Date("2026-01-01T00:00:00Z"),
    });
    repo.saveMatchResult("rem1", { score: 80, matchedSkills: [], missingSkills: [] });
    repo.saveMatchResult("ons1", { score: 70, matchedSkills: [], missingSkills: [] });

    const res = await makeApp().request("/api/matches?remoteOnly=true");
    const body = await json<{ posting: { id: string; remote: boolean } }[]>(res);
    expect(body.map((s) => s.posting.id)).toEqual(["rem1"]);
    expect(body[0]?.posting.remote).toBe(true);
  });

  it("country=US filters to US postings (case-insensitive)", async () => {
    repo.savePosting({
      id: "cus1",
      company: "Co",
      title: "US Job",
      url: "https://co.com/cus1",
      source: "lever",
      description: "desc",
      country: "US",
      fetchedAt: new Date("2026-01-01T00:00:00Z"),
    });
    repo.savePosting({
      id: "cde1",
      company: "Co",
      title: "German Job",
      url: "https://co.com/cde1",
      source: "lever",
      description: "desc",
      country: "Germany",
      fetchedAt: new Date("2026-01-01T00:00:00Z"),
    });
    repo.saveMatchResult("cus1", { score: 80, matchedSkills: [], missingSkills: [] });
    repo.saveMatchResult("cde1", { score: 70, matchedSkills: [], missingSkills: [] });

    const res = await makeApp().request("/api/matches?country=US");
    const body = await json<{ posting: { id: string } }[]>(res);
    expect(body.map((s) => s.posting.id)).toEqual(["cus1"]);

    // Case-insensitive
    const lower = await json<{ posting: { id: string } }[]>(
      await makeApp().request("/api/matches?country=us"),
    );
    expect(lower.map((s) => s.posting.id)).toEqual(["cus1"]);

    // Absent param → all
    const all = await json<unknown[]>(await makeApp().request("/api/matches"));
    expect(all).toHaveLength(2);
  });

  it("remoteOnly absent or non-true returns all postings", async () => {
    repo.savePosting({
      id: "mx1",
      company: "Co",
      title: "Job",
      url: "https://co.com/mx1",
      source: "lever",
      description: "desc",
      remote: true,
      fetchedAt: new Date("2026-01-01T00:00:00Z"),
    });
    repo.savePosting({
      id: "mx2",
      company: "Co",
      title: "Job 2",
      url: "https://co.com/mx2",
      source: "lever",
      description: "desc",
      remote: false,
      fetchedAt: new Date("2026-01-01T00:00:00Z"),
    });
    repo.saveMatchResult("mx1", { score: 80, matchedSkills: [], missingSkills: [] });
    repo.saveMatchResult("mx2", { score: 70, matchedSkills: [], missingSkills: [] });

    const noParam = await json<unknown[]>(await makeApp().request("/api/matches"));
    expect(noParam).toHaveLength(2);

    const nonTrue = await json<unknown[]>(await makeApp().request("/api/matches?remoteOnly=yes"));
    expect(nonTrue).toHaveLength(2);
  });
});

describe("companies", () => {
  it("lists tracked companies", async () => {
    repo.addTrackedCompany("https://acme.com/careers", "Acme");
    const res = await makeApp().request("/api/companies");
    expect(await json(res)).toEqual([{ careersUrl: "https://acme.com/careers", name: "Acme" }]);
  });

  it("lists only un-scrapable directory companies for manual review", async () => {
    const scanId = repo.startScan();
    repo.recordDirectory(scanId, [
      { careersUrl: "https://boards.greenhouse.io/acme", name: "Acme" },
      { careersUrl: "https://www.linkedin.com/company/bigco/jobs/", name: "BigCo" },
    ]);
    const res = await makeApp().request("/api/companies/manual-review");
    // Stored normalized (lower-cased, trailing slash stripped) — see normalizeCareersUrl.
    expect(await json(res)).toEqual([
      { careersUrl: "https://www.linkedin.com/company/bigco/jobs", name: "BigCo" },
    ]);
  });

  it("adds a company (201) and returns the updated list", async () => {
    const res = await makeApp().request("/api/companies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ careersUrl: "https://acme.com/careers", name: "Acme" }),
    });
    expect(res.status).toBe(201);
    expect(await json(res)).toEqual([{ careersUrl: "https://acme.com/careers", name: "Acme" }]);
    expect(repo.listTrackedCompanies()).toHaveLength(1);
  });

  it("adding a case/trailing-slash variant of a tracked URL updates the row, not a duplicate", async () => {
    const app = makeApp();
    await app.request("/api/companies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ careersUrl: "https://Acme.com/careers/", name: "Acme" }),
    });
    const res = await app.request("/api/companies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ careersUrl: "https://acme.com/CAREERS", name: "Acme Inc" }),
    });
    expect(await json(res)).toEqual([{ careersUrl: "https://acme.com/careers", name: "Acme Inc" }]);
    expect(repo.listTrackedCompanies()).toHaveLength(1);
  });

  it("rejects a non-URL or non-http(s) careersUrl", async () => {
    const app = makeApp();
    for (const careersUrl of ["not a url", "ftp://x.com"]) {
      const res = await app.request("/api/companies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ careersUrl }),
      });
      expect(res.status).toBe(400);
    }
    expect(repo.listTrackedCompanies()).toHaveLength(0);
  });

  it("removes a company by url query param", async () => {
    repo.addTrackedCompany("https://acme.com/careers", "Acme");
    const url = encodeURIComponent("https://acme.com/careers");
    const res = await makeApp().request(`/api/companies?url=${url}`, { method: "DELETE" });
    expect(await json<{ removed: boolean }>(res)).toEqual({ removed: true });
    expect(repo.listTrackedCompanies()).toHaveLength(0);
  });

  it("400s a delete with no url, and reports removed=false for an unknown url", async () => {
    const app = makeApp();
    expect((await app.request("/api/companies", { method: "DELETE" })).status).toBe(400);
    const res = await app.request("/api/companies?url=https://nope.com", { method: "DELETE" });
    expect(await json<{ removed: boolean }>(res)).toEqual({ removed: false });
  });
});

describe("GET /api/companies/needs-attention", () => {
  it("returns the needs-attention list", async () => {
    // listNeedsAttention's default threshold is 5 consecutive failures, so record 5 scans' worth
    // (mirrors the loop pattern used in src/cli/main.test.ts for the same threshold).
    for (let scanId = 1; scanId <= 5; scanId += 1) {
      repo.recordScanFailures(
        scanId,
        [{ careersUrl: "https://boom.com/careers", company: "Boom", message: "timeout" }],
        ["https://boom.com/careers"],
      );
    }
    const res = await makeApp().request("/api/companies/needs-attention");
    expect(await json(res)).toEqual([
      {
        careersUrl: "https://boom.com/careers",
        company: "Boom",
        message: "timeout",
        consecutiveFailures: 5,
      },
    ]);
  });
});

describe("GET /api/profile", () => {
  it("returns null when no profile exists", async () => {
    expect(await json(await makeApp().request("/api/profile"))).toBeNull();
  });

  it("returns the latest profile", async () => {
    const profile = buildProfile({ resumeText: "TypeScript and React" });
    repo.saveProfile(profile);
    expect(await json(await makeApp().request("/api/profile"))).toEqual(profile);
  });
});

describe("settings", () => {
  it("masks the API key on read and reports its presence", async () => {
    repo.setSetting("anthropicApiKey", "sk-secret");
    const body = await json(await makeApp().request("/api/settings"));
    expect(body).toEqual({
      hasAnthropicKey: true,
      scorerModel: null,
      scorerProvider: null,
      homeCountry: null,
      hasTheMuseKey: false,
      feedUrl: null,
      hasFeedKey: false,
    });
    expect(JSON.stringify(body)).not.toContain("sk-secret");
  });

  it("stores and echoes back the home country", async () => {
    const res = await makeApp().request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ homeCountry: "US" }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ homeCountry: string | null }>(res);
    expect(body.homeCountry).toBe("US");

    const getRes = await makeApp().request("/api/settings");
    expect(await json<{ homeCountry: string | null }>(getRes)).toMatchObject({
      homeCountry: "US",
    });
  });

  it("stores the feed URL (shown back) and the feed key (write-only, presence only)", async () => {
    const res = await makeApp().request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ feedUrl: "https://proj.supabase.co", feedKey: "anon-secret" }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ feedUrl: string | null; hasFeedKey: boolean }>(res);
    expect(body.feedUrl).toBe("https://proj.supabase.co");
    expect(body.hasFeedKey).toBe(true);
    expect(JSON.stringify(body)).not.toContain("anon-secret");
    expect(repo.getSetting("feedKey")).toBe("anon-secret");
  });

  it("writes the (write-only) Muse key and reports presence without echoing it", async () => {
    const res = await makeApp().request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theMuseApiKey: "muse-secret" }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ hasTheMuseKey: boolean }>(res);
    expect(body.hasTheMuseKey).toBe(true);
    expect(JSON.stringify(body)).not.toContain("muse-secret");
    expect(repo.getSetting("theMuseApiKey")).toBe("muse-secret");
  });

  it("writes provided settings and never echoes the key back", async () => {
    const res = await makeApp().request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anthropicApiKey: "sk-new", scorerModel: "claude-x" }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ hasAnthropicKey: boolean; scorerModel: string | null }>(res);
    expect(body.hasAnthropicKey).toBe(true);
    expect(body.scorerModel).toBe("claude-x");
    expect(repo.getSetting("anthropicApiKey")).toBe("sk-new");
  });

  it("rejects a non-string setting value", async () => {
    const res = await makeApp().request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scorerModel: 42 }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-JSON body", async () => {
    const res = await makeApp().request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/profile", () => {
  it("builds a profile from JSON resume text", async () => {
    const res = await makeApp().request("/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resumeText: "Experienced with TypeScript and React." }),
    });
    expect(res.status).toBe(200);
    const profile = await json<{ skills: string[] }>(res);
    expect(profile.skills).toEqual(expect.arrayContaining(["typescript", "react"]));
    expect(repo.getLatestProfile()).toEqual(profile);
  });

  it("builds a profile from a multipart text-file upload", async () => {
    const form = new FormData();
    form.set("file", new File(["I know TypeScript and AWS."], "cv.txt", { type: "text/plain" }));
    const res = await makeApp().request("/api/profile", { method: "POST", body: form });
    expect(res.status).toBe(200);
    expect((await json<{ skills: string[] }>(res)).skills).toEqual(
      expect.arrayContaining(["typescript", "aws"]),
    );
  });

  it("rejects an empty resumeText", async () => {
    const res = await makeApp().request("/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resumeText: "  " }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unsupported upload format", async () => {
    const form = new FormData();
    form.set("file", new File(["x"], "cv.rtf", { type: "application/rtf" }));
    const res = await makeApp().request("/api/profile", { method: "POST", body: form });
    expect(res.status).toBe(400);
  });

  it("rejects an upload whose declared Content-Length exceeds the limit", async () => {
    const res = await makeApp().request("/api/profile", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(11 * 1024 * 1024),
      },
      body: "ignored — rejected before the body is read",
    });
    expect(res.status).toBe(413);
  });

  it("rejects an oversized file even when Content-Length is absent", async () => {
    const oversized = "a".repeat(11 * 1024 * 1024);
    const form = new FormData();
    form.set("file", new File([oversized], "cv.txt", { type: "text/plain" }));
    const res = await makeApp().request("/api/profile", { method: "POST", body: form });
    expect(res.status).toBe(413);
  });
});

describe("PUT /api/profile/skills", () => {
  it("replaces profile skills (normalized + deduped), preserving other fields", async () => {
    repo.saveProfile({ skills: ["old"], roleKeywords: ["engineer"], categories: ["eng"] });
    const res = await makeApp().request("/api/profile/skills", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skills: ["TypeScript", " react ", "TS", "react"] }),
    });
    expect(res.status).toBe(200);
    const profile = await json<{ skills: string[]; roleKeywords: string[] }>(res);
    // "TS" folds to "typescript" and dedupes; whitespace/casing normalized.
    expect(profile.skills).toEqual(["typescript", "react"]);
    expect(profile.roleKeywords).toEqual(["engineer"]);
    expect(repo.getLatestProfile()?.skills).toEqual(["typescript", "react"]);
  });

  it("works with no prior profile", async () => {
    const res = await makeApp().request("/api/profile/skills", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skills: ["python"] }),
    });
    expect(res.status).toBe(200);
    expect((await json<{ skills: string[] }>(res)).skills).toEqual(["python"]);
  });

  it("rejects a non-array body", async () => {
    const res = await makeApp().request("/api/profile/skills", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skills: "nope" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("skill dictionary CRUD", () => {
  it("lists, adds (201, normalized), and removes dictionary skills", async () => {
    const app = makeApp();
    expect(await json(await app.request("/api/skills"))).toEqual([]);

    const add = await app.request("/api/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "  Rust  ", category: "engineering" }),
    });
    expect(add.status).toBe(201);
    expect(await json<{ name: string; category: string }[]>(add)).toEqual([
      { name: "rust", category: "engineering" },
    ]);

    const del = await app.request("/api/skills/rust", { method: "DELETE" });
    expect(await json<{ removed: boolean }>(del)).toEqual({ removed: true });
    expect(await json(await app.request("/api/skills"))).toEqual([]);
  });

  it("defaults the category to 'other' and rejects a missing name", async () => {
    const app = makeApp();
    await app.request("/api/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "elixir" }),
    });
    expect(
      await json<{ name: string; category: string }[]>(await app.request("/api/skills")),
    ).toEqual([{ name: "elixir", category: "other" }]);

    const bad = await app.request("/api/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: "engineering" }),
    });
    expect(bad.status).toBe(400);
  });

  it("reports removed=false for an unknown skill", async () => {
    const del = await makeApp().request("/api/skills/nonexistent", { method: "DELETE" });
    expect(await json<{ removed: boolean }>(del)).toEqual({ removed: false });
  });
});

describe("scan jobs", () => {
  type ScanStatus = { state: string; count: number | null; error: string | null };

  async function pollUntilSettled(app: ReturnType<typeof makeApp>): Promise<ScanStatus> {
    for (let i = 0; i < 50; i += 1) {
      const status = await json<ScanStatus>(await app.request("/api/scan/status"));
      if (status.state !== "running") return status;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("scan did not settle");
  }

  it("reports an idle status before any scan", async () => {
    const status = await json<ScanStatus>(await makeApp().request("/api/scan/status"));
    expect(status.state).toBe("idle");
  });

  it("starts a background scan (202) and reaches done with the count", async () => {
    const jobs = new ScanJobManager();
    const runScan = vi.fn(async () => ({ count: 3, warnings: [] }));
    const app = makeApp({ jobs, runScanForScope: () => runScan });

    const res = await app.request("/api/scan", { method: "POST" });
    expect(res.status).toBe(202);

    const status = await pollUntilSettled(app);
    expect(status.state).toBe("done");
    expect(status.count).toBe(3);
    expect(runScan).toHaveBeenCalledOnce();
  });

  it("rejects a second concurrent scan with 409 (single-flight)", async () => {
    const jobs = new ScanJobManager();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runScan = vi.fn(async () => {
      await gate;
      return { count: 0, warnings: [] };
    });
    const app = makeApp({ jobs, runScanForScope: () => runScan });

    expect((await app.request("/api/scan", { method: "POST" })).status).toBe(202);
    expect((await app.request("/api/scan", { method: "POST" })).status).toBe(409);

    release();
    expect((await pollUntilSettled(app)).state).toBe("done");
    expect(runScan).toHaveBeenCalledOnce();
  });

  it("records the error when the scan runner throws", async () => {
    const runScan = vi.fn(async () => {
      throw new Error("no profile yet");
    });
    const app = makeApp({ runScanForScope: () => runScan });
    await app.request("/api/scan", { method: "POST" });

    const status = await pollUntilSettled(app);
    expect(status.state).toBe("error");
    expect(status.error).toContain("no profile yet");
  });

  it("defaults to the incremental scope when the request has no body", async () => {
    const scopes: string[] = [];
    const app = makeApp({
      runScanForScope: (scope) => {
        scopes.push(scope);
        return async () => ({ count: 0, warnings: [] });
      },
    });

    const res = await app.request("/api/scan", { method: "POST" });
    expect(res.status).toBe(202);
    await pollUntilSettled(app);
    expect(scopes).toEqual(["incremental"]);
  });

  it("honors scope:full from the request body", async () => {
    const scopes: string[] = [];
    const app = makeApp({
      runScanForScope: (scope) => {
        scopes.push(scope);
        return async () => ({ count: 0, warnings: [] });
      },
    });

    const res = await app.request("/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "full" }),
    });
    expect(res.status).toBe(202);
    await pollUntilSettled(app);
    expect(scopes).toEqual(["full"]);
  });

  it("falls back to incremental for an invalid scope value", async () => {
    const scopes: string[] = [];
    const app = makeApp({
      runScanForScope: (scope) => {
        scopes.push(scope);
        return async () => ({ count: 0, warnings: [] });
      },
    });

    const res = await app.request("/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "sideways" }),
    });
    expect(res.status).toBe(202);
    await pollUntilSettled(app);
    expect(scopes).toEqual(["incremental"]);
  });
});

describe("POST /api/scan/retry-failed", () => {
  it("starts the retry-failed scan job (202) and reports 409 if already running", async () => {
    const jobs = new ScanJobManager();
    const app = makeApp({
      jobs,
      retryFailedScan: async () => ({ count: 0, warnings: [] }),
    });
    const first = await app.request("/api/scan/retry-failed", { method: "POST" });
    expect(first.status).toBe(202);

    // Force "running" by starting a long job directly, then confirm the second call 409s.
    jobs.start(() => new Promise(() => {})); // never resolves within the test
    const second = await app.request("/api/scan/retry-failed", { method: "POST" });
    expect(second.status).toBe(409);
  });
});

describe("deep-score jobs", () => {
  type ScoreStatus = {
    state: string;
    counts: { deepScored: number } | null;
    error: string | null;
    abortedOnLimit: boolean;
  };

  async function pollUntilSettled(app: ReturnType<typeof makeApp>): Promise<ScoreStatus> {
    for (let i = 0; i < 50; i += 1) {
      const status = await json<ScoreStatus>(await app.request("/api/score/status"));
      if (status.state !== "running") return status;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("score did not settle");
  }

  function score(body: unknown = {}) {
    return {
      method: "POST" as const,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  it("preview returns the plan counts and cost estimate", async () => {
    repo.setSetting(ANTHROPIC_KEY_SETTING, "sk-ant-test");
    const app = makeApp({
      previewScore: async () =>
        fakeScoreResult({ counts: { ...fakeScoreResult().counts, afterCap: 12 } }),
    });
    const res = await app.request("/api/score/preview", score({ limit: 50 }));
    expect(res.status).toBe(200);
    const body = await json<{ counts: { afterCap: number }; estimate: { totalUsd: number } }>(res);
    expect(body.counts.afterCap).toBe(12);
    expect(body.estimate).toBeDefined();
  });

  it("preview returns 400 when no key is configured", async () => {
    const app = makeApp({
      previewScore: async () => {
        throw new NoApiKeyError();
      },
    });
    const res = await app.request("/api/score/preview", score());
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toMatch(/no anthropic key/i);
  });

  it("POST /api/score starts a job (202) and reaches done with the deep-scored count", async () => {
    repo.setSetting(ANTHROPIC_KEY_SETTING, "sk-ant-test");
    const createScoreRun = vi.fn(
      () => async () => fakeScoreResult({ counts: { ...fakeScoreResult().counts, deepScored: 4 } }),
    );
    const app = makeApp({ createScoreRun });

    const res = await app.request("/api/score", score({ remoteOnly: true, limit: 20 }));
    expect(res.status).toBe(202);

    const status = await pollUntilSettled(app);
    expect(status.state).toBe("done");
    expect(status.counts?.deepScored).toBe(4);
    // rescore defaults to false when the request body omits it.
    expect(createScoreRun).toHaveBeenCalledWith({ remoteOnly: true, limit: 20, rescore: false });
  });

  it("passes rescore through to the score runner when the request sets it", async () => {
    repo.setSetting(ANTHROPIC_KEY_SETTING, "sk-ant-test");
    const createScoreRun = vi.fn(() => async () => fakeScoreResult());
    const app = makeApp({ createScoreRun });

    const res = await app.request(
      "/api/score",
      score({ remoteOnly: false, limit: 20, rescore: true }),
    );
    expect(res.status).toBe(202);
    await pollUntilSettled(app);
    expect(createScoreRun).toHaveBeenCalledWith({ remoteOnly: false, limit: 20, rescore: true });
  });

  it("rejects POST /api/score with 400 when no key is configured (before starting a job)", async () => {
    const createScoreRun = vi.fn(() => async () => fakeScoreResult());
    const app = makeApp({ createScoreRun });
    const res = await app.request("/api/score", score());
    expect(res.status).toBe(400);
    expect(createScoreRun).not.toHaveBeenCalled();
  });

  it("is single-flight: a second POST returns 409 while running", async () => {
    repo.setSetting(ANTHROPIC_KEY_SETTING, "sk-ant-test");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const createScoreRun = () => async () => {
      await gate;
      return fakeScoreResult();
    };
    const app = makeApp({ createScoreRun });

    expect((await app.request("/api/score", score())).status).toBe(202);
    expect((await app.request("/api/score", score())).status).toBe(409);

    release();
    expect((await pollUntilSettled(app)).state).toBe("done");
  });

  it("hasAnthropicKey reflects the ANTHROPIC_API_KEY env var, not just the stored key", async () => {
    // No stored key, but the env var is set → the UI should see deep-score as available.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-from-env");
    const settings = await json<{ hasAnthropicKey: boolean }>(
      await makeApp().request("/api/settings"),
    );
    expect(settings.hasAnthropicKey).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe("applied action API", () => {
  const samplePosting = {
    company: "Acme",
    title: "Engineer",
    url: "https://acme.com/jobs/1",
    source: "greenhouse" as const,
    description: "TypeScript",
    fetchedAt: new Date("2026-01-01T00:00:00Z"),
  };

  it("accepts applied on the action endpoint", async () => {
    const app = makeApp();
    repo.savePosting({ ...samplePosting, id: "a1" });
    repo.saveMatchResult("a1", { score: 90, matchedSkills: [], missingSkills: [] });
    const res = await app.request("/api/matches/a1/action", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "applied" }),
    });
    expect(res.status).toBe(200);
    // Hidden by default, visible with includeApplied.
    const def = await json<unknown[]>(await app.request("/api/matches?minScore=0"));
    expect(def).toHaveLength(0);
    const shown = await json<unknown[]>(
      await app.request("/api/matches?minScore=0&includeApplied=true"),
    );
    expect(shown).toHaveLength(1);
  });

  it("rejects an unknown action", async () => {
    const app = makeApp();
    const res = await app.request("/api/matches/x/action", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "bogus" }),
    });
    expect(res.status).toBe(400);
  });

  it("onlyApplied returns just applied postings", async () => {
    const app = makeApp();
    repo.savePosting({ ...samplePosting, id: "ap" });
    repo.saveMatchResult("ap", { score: 90, matchedSkills: [], missingSkills: [] });
    repo.setUserAction("ap", "applied");
    repo.savePosting({ ...samplePosting, id: "no" });
    repo.saveMatchResult("no", { score: 80, matchedSkills: [], missingSkills: [] });
    const only = await json<{ posting: { id: string } }[]>(
      await app.request("/api/matches?minScore=0&onlyApplied=true"),
    );
    expect(only.map((s) => s.posting.id)).toEqual(["ap"]);
  });
});

describe("GET /api/scans/latest", () => {
  it("returns null before any scan, then the latest finished scan's diff", async () => {
    const app = makeApp();
    expect(await json(await app.request("/api/scans/latest"))).toBeNull();

    const s = repo.startScan();
    repo.finishScan(s, {
      postingsSeen: 5,
      companiesSeen: 2,
      newCompanies: [{ careersUrl: "https://new.co", name: "New" }],
      removedCompanies: [],
    });
    const latest = await json<{ postingsSeen: number; newCompanies: { careersUrl: string }[] }>(
      await app.request("/api/scans/latest"),
    );
    expect(latest.postingsSeen).toBe(5);
    expect(latest.newCompanies).toEqual([{ careersUrl: "https://new.co", name: "New" }]);
  });
});

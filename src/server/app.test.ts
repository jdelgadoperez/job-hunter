import { buildProfile } from "@app/profile/build-profile";
import { Repository } from "@app/storage/repository";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import type { ScanProgress, ScanRunner, ServerDeps } from "./types";

/** `Response.json()` is typed `unknown`; this narrows it at the call site without `any`. */
async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

let repo: Repository;

function makeApp(overrides: Partial<ServerDeps> = {}) {
  const deps: ServerDeps = {
    repo,
    runScan: async () => ({ count: 0, warnings: [] }),
    buildProfileFromText: (text) => buildProfile({ resumeText: text }),
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
});

describe("GET /api/companies", () => {
  it("lists tracked companies", async () => {
    repo.addTrackedCompany("https://acme.com/careers", "Acme");
    const res = await makeApp().request("/api/companies");
    expect(await json(res)).toEqual([{ careersUrl: "https://acme.com/careers", name: "Acme" }]);
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
    repo.setSetting("airtableShareUrl", "https://airtable.com/shrX");
    const body = await json(await makeApp().request("/api/settings"));
    expect(body).toEqual({
      hasAnthropicKey: true,
      scorerModel: null,
      scorerProvider: null,
      airtableShareUrl: "https://airtable.com/shrX",
    });
    expect(JSON.stringify(body)).not.toContain("sk-secret");
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
});

describe("POST /api/scan (SSE)", () => {
  async function readStream(res: Response): Promise<string> {
    return await res.text();
  }

  it("streams progress events from the scan runner", async () => {
    const runScan: ScanRunner = async (onProgress) => {
      const events: ScanProgress[] = [
        { phase: "start" },
        { phase: "log", message: "Scanned 1 posting(s)." },
        { phase: "done", count: 1, warnings: [] },
      ];
      for (const e of events) onProgress(e);
      return { count: 1, warnings: [] };
    };
    const res = await makeApp({ runScan }).request("/api/scan", { method: "POST" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await readStream(res);
    expect(text).toContain("event: start");
    expect(text).toContain("event: log");
    expect(text).toContain("event: done");
    expect(text).toContain('"count":1');
  });

  it("emits an error event when the scan runner throws", async () => {
    const runScan: ScanRunner = async () => {
      throw new Error("no profile yet");
    };
    const res = await makeApp({ runScan }).request("/api/scan", { method: "POST" });
    const text = await readStream(res);
    expect(text).toContain("event: error");
    expect(text).toContain("no profile yet");
  });
});

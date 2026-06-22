import { buildProfile } from "@app/profile/build-profile";
import { Repository } from "@app/storage/repository";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { ScanJobManager } from "./scan-job";
import type { ServerDeps } from "./types";

/** `Response.json()` is typed `unknown`; this narrows it at the call site without `any`. */
async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

let repo: Repository;

function makeApp(overrides: Partial<ServerDeps> = {}) {
  const deps: ServerDeps = {
    repo,
    jobs: new ScanJobManager(),
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
    const body = await json(await makeApp().request("/api/settings"));
    expect(body).toEqual({
      hasAnthropicKey: true,
      scorerModel: null,
      scorerProvider: null,
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
    const app = makeApp({ jobs, runScan });

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
    const app = makeApp({ jobs, runScan });

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
    const app = makeApp({ runScan });
    await app.request("/api/scan", { method: "POST" });

    const status = await pollUntilSettled(app);
    expect(status.state).toBe("error");
    expect(status.error).toContain("no profile yet");
  });
});

import { buildProfile } from "@app/profile/build-profile";
import { Repository } from "@app/storage/repository";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { ScanJobManager } from "./scan-job";
import { ScoreJobManager } from "./score-job";

type App = { id: number; status: string; archived: boolean; notes: { content: string }[] } & Record<
  string,
  unknown
>;

let repo: Repository;

function makeApp() {
  const empty = async () => {
    throw new Error("not used");
  };
  return createApp({
    repo,
    jobs: new ScanJobManager(),
    runScanForScope: () => async () => ({ count: 0, warnings: [] }),
    retryFailedScan: async () => ({ count: 0, warnings: [] }),
    scoreJobs: new ScoreJobManager(),
    createScoreRun: () => empty,
    previewScore: empty,
    buildProfileFromText: (text) => buildProfile({ resumeText: text }),
    getUpdateStatus: async () => ({ version: "0.1.0", behind: 0, updateAvailable: false }),
  });
}

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const res = await makeApp().request(path, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
  });
  return { status: res.status, data: await res.json() };
}

beforeEach(() => {
  repo = new Repository(":memory:", { today: () => "2026-11-11" });
});
afterEach(() => repo.close());

describe("applications API", () => {
  it("creates, reads, lists, and counts", async () => {
    const created = await call("POST", "/api/applications", {
      company: "Acme",
      role: "Eng",
      url: "https://a",
      salaryRange: "200k",
    });
    expect(created.status).toBe(201);
    const app = created.data as App;
    expect(app).toMatchObject({ company: "Acme", status: "applied", dateApplied: "2026-11-11" });

    expect((await call("GET", `/api/applications/${app.id}`)).data).toMatchObject({ id: app.id });
    expect((await call("GET", "/api/applications")).data).toHaveLength(1);
    expect((await call("GET", "/api/applications?status=offered")).data).toHaveLength(0);
    expect((await call("GET", "/api/applications?search=200k")).data).toHaveLength(1);
    expect((await call("GET", "/api/applications/stats")).data).toEqual({
      active: { applied: 1 },
      archived: {},
    });
  });

  it("validates create bodies", async () => {
    expect((await call("POST", "/api/applications", "not json")).status).toBe(400);
    expect((await call("POST", "/api/applications", { company: "Acme" })).status).toBe(400);
    expect((await call("POST", "/api/applications", { company: 1, role: "x" })).status).toBe(400);
    expect(
      (await call("POST", "/api/applications", { company: "A", role: "x", postingId: 3 })).status,
    ).toBe(400);
    const badDate = await call("POST", "/api/applications", {
      company: "A",
      role: "x",
      dateApplied: "nope",
    });
    expect(badDate).toEqual({
      status: 400,
      data: { error: expect.stringContaining("invalid date") },
    });
    expect((await call("GET", "/api/applications?status=hired")).status).toBe(400);
  });

  it("links a posting on create so the match leaves the default list", async () => {
    repo.savePosting({
      id: "p1",
      company: "Acme",
      title: "Eng",
      url: "https://a/1",
      source: "lever",
      description: "",
      fetchedAt: new Date(),
    });
    repo.saveMatchResult("p1", { score: 90, matchedSkills: [], missingSkills: [] });
    const created = await call("POST", "/api/applications", {
      company: "Acme",
      role: "Eng",
      postingId: "p1",
    });
    expect(created.status).toBe(201);
    expect(repo.listScoredPostings(0)).toHaveLength(0);
    expect(repo.applications.list()).toHaveLength(1);

    // Marking the match applied from the matches API reuses the same application.
    await call("PUT", "/api/matches/p1/action", { action: "applied" });
    expect(repo.applications.list()).toHaveLength(1);

    const id = (created.data as App).id;
    expect(await call("DELETE", `/api/applications/${id}`)).toEqual({
      status: 200,
      data: { removed: true },
    });
    expect(repo.listScoredPostings(0)).toHaveLength(1);
  });

  it("marking a match applied creates an application visible over the API", async () => {
    repo.savePosting({
      id: "p2",
      company: "Globex",
      title: "Designer",
      url: "https://g/2",
      source: "ashby",
      description: "",
      fetchedAt: new Date(),
    });
    repo.saveMatchResult("p2", { score: 70, matchedSkills: [], missingSkills: [] });
    await call("PUT", "/api/matches/p2/action", { action: "applied" });
    const list = (await call("GET", "/api/applications")).data as App[];
    expect(list).toMatchObject([{ company: "Globex", role: "Designer", postingId: "p2" }]);
    await call("DELETE", "/api/matches/p2/action");
    expect((await call("GET", "/api/applications")).data).toEqual([]);
  });

  it("patches fields and status together, logging the change", async () => {
    const { id } = repo.applications.add({ company: "Acme", role: "Eng", recruiter: "Kim" });
    const res = await call("PATCH", `/api/applications/${id}`, {
      role: "Senior Eng",
      recruiter: null,
      status: "interviewed",
      statusDate: "2026-11-20",
    });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ role: "Senior Eng", recruiter: null, status: "interviewed" });
    expect((res.data as App).notes.at(-1)?.content).toBe(
      "Status changed from Applied to Interviewed",
    );

    expect((await call("PATCH", `/api/applications/${id}`, { status: "hired" })).status).toBe(400);
    expect((await call("PATCH", `/api/applications/${id}`, { statusDate: 5 })).status).toBe(400);
    expect((await call("PATCH", `/api/applications/${id}`, { company: null })).status).toBe(400);
    expect((await call("PATCH", `/api/applications/${id}`, { company: " " })).status).toBe(400);
    expect((await call("PATCH", `/api/applications/${id}`, [])).status).toBe(400);
  });

  it("adds notes", async () => {
    const { id } = repo.applications.add({ company: "Acme", role: "Eng" });
    const res = await call("POST", `/api/applications/${id}/notes`, {
      content: "Recruiter call",
      date: "2026-11-12",
    });
    expect(res.status).toBe(201);
    expect((res.data as App).notes.at(-1)).toMatchObject({ content: "Recruiter call" });
    expect((await call("POST", `/api/applications/${id}/notes`, {})).status).toBe(400);
    expect(
      (await call("POST", `/api/applications/${id}/notes`, { content: "x", date: 1 })).status,
    ).toBe(400);
    expect((await call("POST", `/api/applications/${id}/notes`, { content: " " })).status).toBe(
      400,
    );
  });

  it("archives closed applications and restores them", async () => {
    const { id } = repo.applications.add({ company: "Acme", role: "Eng" });
    expect((await call("POST", `/api/applications/${id}/archive`)).status).toBe(400);
    repo.applications.setStatus(id, "rejected");
    expect((await call("POST", `/api/applications/${id}/archive`)).data).toMatchObject({
      archived: true,
    });
    expect((await call("GET", "/api/applications?archived=true")).data).toHaveLength(1);
    expect((await call("POST", `/api/applications/${id}/unarchive`)).data).toMatchObject({
      archived: false,
    });
  });

  it("404s on unknown ids", async () => {
    for (const [method, path] of [
      ["GET", "/api/applications/99"],
      ["GET", "/api/applications/abc"],
      ["PATCH", "/api/applications/99"],
      ["POST", "/api/applications/99/notes"],
      ["POST", "/api/applications/99/archive"],
      ["POST", "/api/applications/99/unarchive"],
      ["DELETE", "/api/applications/99"],
    ] as const) {
      expect((await call(method, path, method === "GET" ? undefined : {})).status).toBe(404);
    }
  });
});

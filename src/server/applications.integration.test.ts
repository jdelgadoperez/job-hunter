import { buildProfile } from "@app/profile/build-profile";
import { Repository } from "@app/storage/repository";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, rawDocumentHeaders } from "./app";
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

  it("turns unexpected errors into a 500 instead of a 400", async () => {
    const spy = vi.spyOn(repo.applications, "list").mockImplementation(() => {
      throw new TypeError("boom");
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await makeApp().request("/api/applications");
    expect(res.status).toBe(500);
    spy.mockRestore();
    quiet.mockRestore();
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

describe("documents API", () => {
  it("creates, reads, updates, lists, serves, and deletes notes", async () => {
    const { id } = repo.applications.add({ company: "Acme", role: "Eng" });
    const base = `/api/applications/${id}/documents`;
    const created = await call("POST", base, { name: "prep.md", content: "# Prep" });
    expect(created.status).toBe(201);
    const docId = (created.data as { id: number }).id;

    expect((await call("GET", base)).data).toMatchObject([{ name: "prep.md", kind: "note" }]);
    expect((await call("GET", `${base}/${docId}`)).data).toMatchObject({ content: "# Prep" });
    const put = await call("PUT", `${base}/${docId}`, { content: "# Prep v2" });
    expect(put.data).toMatchObject({ content: "# Prep v2" });

    const raw = await makeApp().request(`${base}/${docId}/raw`);
    expect(raw.headers.get("content-type")).toContain("text/markdown");
    expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await raw.text()).toBe("# Prep v2");

    expect(await call("DELETE", `${base}/${docId}`)).toEqual({
      status: 200,
      data: { removed: true },
    });
    expect((await call("DELETE", `${base}/${docId}`)).status).toBe(404);
  });

  it("returns metadata for files and validates input", async () => {
    const { id } = repo.applications.add({ company: "Acme", role: "Eng" });
    const base = `/api/applications/${id}/documents`;
    // A file-kind row (no docsDir here, so insert directly; /raw then 404s as missing).
    repo.connection
      .prepare(
        "INSERT INTO application_documents (application_id, name, kind, file_path, mime, size) VALUES (?, 'a.pdf', 'file', '/nowhere/a.pdf', 'application/pdf', 3)",
      )
      .run(id);
    const fileId = repo.documents.list(id)[0]?.id;
    expect((await call("GET", `${base}/${fileId}`)).data).toMatchObject({
      kind: "file",
      mime: "application/pdf",
    });
    expect((await makeApp().request(`${base}/${fileId}/raw`)).status).toBe(404);
    expect((await call("PUT", `${base}/${fileId}`, { content: "x" })).status).toBe(400);

    expect((await call("POST", base, { name: "x.md" })).status).toBe(400);
    expect((await call("POST", base, { name: "../x.md", content: "x" })).status).toBe(400);
    expect((await call("PUT", `${base}/${fileId}`, {})).status).toBe(400);
    for (const [method, path] of [
      ["GET", "/api/applications/99/documents"],
      ["POST", "/api/applications/99/documents"],
      ["GET", `${base}/999`],
      ["PUT", `${base}/999`],
      ["DELETE", `${base}/999`],
      ["GET", `${base}/999/raw`],
      ["GET", "/api/applications/99/documents/1/raw"],
    ] as const) {
      const res =
        method === "GET" && path.endsWith("/raw")
          ? { status: (await makeApp().request(path)).status }
          : await call(method, path, method === "GET" ? undefined : { content: "x", name: "a.md" });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });
});

describe("rawDocumentHeaders", () => {
  it("serves inert types inline and sandboxes everything else as a download", () => {
    expect(rawDocumentHeaders("resume/r.pdf", "application/pdf")).toEqual({
      "content-type": "application/pdf",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "content-disposition": "inline; filename*=UTF-8''r.pdf",
    });
    const svg = rawDocumentHeaders("Arch — v2.svg", "image/svg+xml");
    expect(svg["content-disposition"]).toBe(
      "attachment; filename*=UTF-8''Arch%20%E2%80%94%20v2.svg",
    );
    expect(svg["content-security-policy"]).toBe("sandbox; default-src 'none'");
    expect(rawDocumentHeaders("x.bin", "application/octet-stream")["content-security-policy"]).toBe(
      "sandbox; default-src 'none'",
    );
  });
});

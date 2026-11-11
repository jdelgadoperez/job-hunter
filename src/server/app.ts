import {
  type ApplicationPatch,
  type ApplicationStatus,
  isApplicationStatus,
  type NewApplication,
} from "@app/applications/model";
import { ApplicationError } from "@app/applications/store";
import { isUnscrapableHost } from "@app/discovery/unscrapable";
import { normalizeSkill } from "@app/domain/normalize";
import type { SkillProfile } from "@app/domain/types";
import { resolveHomeCountry, settingsWithEnvKey } from "@app/matching/resolve-settings";
import { DEFAULT_SCORE_LIMIT } from "@app/matching/score-defaults";
import {
  ANTHROPIC_KEY_SETTING,
  FEED_KEY_SETTING,
  FEED_URL_SETTING,
  HOME_COUNTRY_SETTING,
  MODEL_SETTING,
  PROVIDER_SETTING,
  SCAN_FRESHNESS_SETTING,
  THE_MUSE_KEY_SETTING,
} from "@app/matching/settings-keys";
import { errorMessage } from "@app/net/error-message";
import { detectHomeCountry } from "@app/profile/detect-home-country";
import { readResumeBuffer } from "@app/profile/read-resume";
import { Hono } from "hono";
import { NoApiKeyError } from "./score-runner";
import type { ScoreRunOptions, ServerDeps } from "./types";

// The Airtable directory URL is a fixed community resource (see `resolveShareUrl`), not user
// config, so it's intentionally absent from the settings API.

/** Settings shape returned to clients — secret keys are never echoed back, only their presence. */
function readSettings(repo: ServerDeps["repo"]) {
  return {
    // Resolve through the env fallback so the client's "deep-score available?" signal matches what
    // the score-runner actually sees (it uses settingsWithEnvKey too): a user with only the
    // ANTHROPIC_API_KEY env var set should read hasAnthropicKey: true.
    hasAnthropicKey: Boolean(settingsWithEnvKey(repo).getSetting(ANTHROPIC_KEY_SETTING)?.trim()),
    scorerModel: repo.getSetting(MODEL_SETTING) ?? null,
    scorerProvider: repo.getSetting(PROVIDER_SETTING) ?? null,
    homeCountry: repo.getSetting(HOME_COUNTRY_SETTING) ?? null,
    scanFreshnessHours: repo.getSetting(SCAN_FRESHNESS_SETTING) ?? null,
    hasTheMuseKey: Boolean(repo.getSetting(THE_MUSE_KEY_SETTING)?.trim()),
    // Remote feed: the URL is shown back (not secret); the anon key is write-only (presence only).
    feedUrl: repo.getSetting(FEED_URL_SETTING) ?? null,
    hasFeedKey: Boolean(repo.getSetting(FEED_KEY_SETTING)?.trim()),
  };
}

// Writable settings keys, mapped from request-body field → settings key. Secret keys (the LLM API
// key, The Muse lead-source key) are included here write-only; reads go through `readSettings`,
// which masks them and reports only their presence.
const WRITABLE_SETTINGS: Record<string, string> = {
  anthropicApiKey: ANTHROPIC_KEY_SETTING,
  scorerModel: MODEL_SETTING,
  scorerProvider: PROVIDER_SETTING,
  homeCountry: HOME_COUNTRY_SETTING,
  scanFreshnessHours: SCAN_FRESHNESS_SETTING,
  theMuseApiKey: THE_MUSE_KEY_SETTING,
  feedUrl: FEED_URL_SETTING,
  feedKey: FEED_KEY_SETTING,
};

// Cap resume uploads so a runaway or malicious request can't read an unbounded file into memory
// and OOM the process. 10MB is generous for any real resume (PDF/docx). Enforced both via the
// declared Content-Length (cheap, pre-read) and the actual decoded file size (the spoof-proof check).
const MAX_RESUME_BYTES = 10 * 1024 * 1024;

// The server binds to loopback and has no authentication, so it trusts that every request
// originates from this machine. A `Host` header naming anything other than loopback means the
// request was routed here under a different name — the signature of a DNS-rebinding attack, where
// a page the user visits points its own domain at 127.0.0.1 to reach this local API. Reject those.
// Requests with no `Host` header (e.g. curl/HTTP-1.0) are allowed; only browsers send one.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return true;
  return LOOPBACK_HOSTS.has(hostHeader.replace(/:\d+$/, "").toLowerCase());
}

/**
 * Build the local web app: a read API over the `Repository`, a streaming `POST /api/scan`, and
 * settings/resume writes. All dependencies are injected (`ServerDeps`) so every route handler is
 * unit-tested against an in-memory repo and a fake scan runner — no listening server, browser, or
 * network. The production listener and the real scan pipeline live in `serve.ts` (smoke-only).
 */
export function createApp(deps: ServerDeps): Hono {
  const {
    repo,
    jobs,
    runScanForScope,
    retryFailedScan,
    scoreJobs,
    createScoreRun,
    previewScore,
    buildProfileFromText,
    getUpdateStatus,
  } = deps;
  const app = new Hono();

  // Defense-in-depth against DNS rebinding: only serve requests addressed to a loopback host.
  app.use("*", async (c, next) => {
    if (!isLoopbackHost(c.req.header("host"))) return c.json({ error: "forbidden host" }, 403);
    await next();
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  // Installed version + whether the remote has newer commits (drives the "update available" nudge).
  app.get("/api/version", async (c) => c.json(await getUpdateStatus()));

  app.get("/api/matches", (c) => {
    const raw = c.req.query("minScore");
    const parsed = raw === undefined ? 0 : Number(raw);
    const minScore = Number.isFinite(parsed) ? parsed : 0;
    const country = c.req.query("country") || undefined;
    const search = c.req.query("search") || undefined;
    return c.json(
      repo.listScoredPostings(minScore, {
        includeExpired: c.req.query("includeExpired") === "true",
        includeDismissed: c.req.query("includeDismissed") === "true",
        remoteOnly: c.req.query("remoteOnly") === "true",
        country,
        includeApplied: c.req.query("includeApplied") === "true",
        onlyApplied: c.req.query("onlyApplied") === "true",
        search,
      }),
    );
  });

  // Save or dismiss a match; DELETE clears the action. The id is the posting id.
  app.put("/api/matches/:id/action", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { action?: unknown } | null;
    if (body?.action !== "saved" && body?.action !== "dismissed" && body?.action !== "applied") {
      return c.json({ error: 'expected { "action": "saved" | "dismissed" | "applied" }' }, 400);
    }
    repo.setUserAction(c.req.param("id"), body.action);
    return c.json({ ok: true });
  });

  app.delete("/api/matches/:id/action", (c) => {
    return c.json({ removed: repo.clearUserAction(c.req.param("id")) });
  });

  registerApplicationRoutes(app, repo);

  app.get("/api/companies", (c) => c.json(repo.listTrackedCompanies()));

  // Directory companies we don't auto-scan (LinkedIn/Indeed/…) — surfaced so the user can review
  // them by hand rather than silently losing them.
  app.get("/api/companies/manual-review", (c) =>
    c.json(
      repo.listDirectoryCompanies().filter((company) => isUnscrapableHost(company.careersUrl)),
    ),
  );

  // Companies with repeated per-company scan failures (>=5 consecutive), for the dashboard's
  // "needs attention" surface.
  app.get("/api/companies/needs-attention", (c) => c.json(repo.listNeedsAttention()));

  // Track a company by its careers-page URL. Validated as an http(s) URL so a typo doesn't become
  // a phantom lead. Upserts by URL; returns the updated list.
  app.post("/api/companies", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      careersUrl?: unknown;
      name?: unknown;
    } | null;
    if (!body || typeof body.careersUrl !== "string") {
      return c.json({ error: 'expected { "careersUrl": string, "name"?: string }' }, 400);
    }
    const careersUrl = body.careersUrl.trim();
    let parsed: URL;
    try {
      parsed = new URL(careersUrl);
    } catch {
      return c.json({ error: "careersUrl must be a valid URL" }, 400);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return c.json({ error: "careersUrl must start with http:// or https://" }, 400);
    }
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
    repo.addTrackedCompany(careersUrl, name);
    return c.json(repo.listTrackedCompanies(), 201);
  });

  // Stop tracking a company. The URL goes in a query param since careers URLs contain slashes.
  app.delete("/api/companies", (c) => {
    const url = c.req.query("url");
    if (!url) return c.json({ error: "missing url query param" }, 400);
    return c.json({ removed: repo.removeTrackedCompany(url) });
  });

  app.get("/api/profile", (c) => c.json(repo.getLatestProfile() ?? null));

  app.get("/api/settings", (c) => c.json(readSettings(repo)));

  app.put("/api/settings", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "expected a JSON object body" }, 400);
    }
    if (typeof body !== "object" || body === null) {
      return c.json({ error: "expected a JSON object body" }, 400);
    }
    for (const [field, key] of Object.entries(WRITABLE_SETTINGS)) {
      const value = body[field];
      if (value === undefined) continue;
      if (typeof value !== "string") {
        return c.json({ error: `"${field}" must be a string` }, 400);
      }
      repo.setSetting(key, value.trim());
    }
    return c.json(readSettings(repo));
  });

  app.post("/api/profile", async (c) => {
    let resumeText: string;
    const contentType = c.req.header("content-type") ?? "";
    // Reject early on the declared size before reading the body into memory.
    const declaredLength = Number(c.req.header("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESUME_BYTES) {
      return c.json({ error: "resume exceeds the 10MB limit" }, 413);
    }
    try {
      if (contentType.includes("multipart/form-data")) {
        const body = await c.req.parseBody();
        const file = body.file;
        if (!(file instanceof File)) {
          return c.json({ error: 'expected a "file" upload field' }, 400);
        }
        if (file.size > MAX_RESUME_BYTES) {
          return c.json({ error: "resume exceeds the 10MB limit" }, 413);
        }
        const ext = `.${file.name.split(".").pop()?.toLowerCase() ?? ""}`;
        resumeText = await readResumeBuffer(new Uint8Array(await file.arrayBuffer()), ext);
      } else {
        const body = (await c.req.json()) as { resumeText?: unknown };
        if (typeof body.resumeText !== "string" || body.resumeText.trim() === "") {
          return c.json({ error: 'expected { "resumeText": string }' }, 400);
        }
        resumeText = body.resumeText;
      }
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
    const profile = buildProfileFromText(resumeText);
    repo.saveProfile(profile);
    const detected = detectHomeCountry(resumeText, resolveHomeCountry(repo));
    if (detected !== undefined) repo.setSetting(HOME_COUNTRY_SETTING, detected);
    return c.json(profile);
  });

  // Replace the profile's skill list directly (manual edits from the UI), preserving the rest of
  // the profile. Skills are normalized + de-duplicated so they match the scorer's expectations.
  app.put("/api/profile/skills", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { skills?: unknown } | null;
    if (!body || !Array.isArray(body.skills) || !body.skills.every((s) => typeof s === "string")) {
      return c.json({ error: 'expected { "skills": string[] }' }, 400);
    }
    const skills = [...new Set((body.skills as string[]).map(normalizeSkill).filter(Boolean))];
    const current = repo.getLatestProfile();
    const profile: SkillProfile = {
      roleKeywords: current?.roleKeywords ?? [],
      categories: current?.categories ?? [],
      ...current,
      skills,
    };
    repo.saveProfile(profile);
    return c.json(profile);
  });

  // The skill dictionary the resume parser recognizes (seeded taxonomy + user additions).
  app.get("/api/skills", (c) => c.json(repo.listSkills()));

  app.post("/api/skills", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      category?: unknown;
    } | null;
    if (!body || typeof body.name !== "string") {
      return c.json({ error: 'expected { "name": string, "category"?: string }' }, 400);
    }
    const name = normalizeSkill(body.name);
    if (!name) return c.json({ error: "skill name is empty" }, 400);
    const category =
      typeof body.category === "string" && body.category.trim() ? body.category.trim() : "other";
    repo.addSkill(name, category);
    return c.json(repo.listSkills(), 201);
  });

  app.delete("/api/skills/:name", (c) => {
    const removed = repo.removeSkill(normalizeSkill(c.req.param("name")));
    return c.json({ removed });
  });

  // Start a background scan (single-flight). 202 when started, 409 if one is already running.
  // Either way the body is the current job status, so the client can begin polling immediately.
  app.post("/api/scan", async (c) => {
    const scope = await parseScanScope(c);
    const started = jobs.start(runScanForScope(scope));
    return c.json(jobs.getStatus(), started ? 202 : 409);
  });

  // Rescan only the companies currently in the "needs attention" list (>=5 consecutive failures).
  // Same single-flight 202/409 contract as POST /api/scan.
  app.post("/api/scan/retry-failed", (c) => {
    const started = jobs.start(retryFailedScan);
    return c.json(jobs.getStatus(), started ? 202 : 409);
  });

  app.get("/api/scan/status", (c) => c.json(jobs.getStatus()));

  // The most recently completed scan: counts plus the directory diff (new/removed companies).
  app.get("/api/scans/latest", (c) => c.json(repo.getLatestScan() ?? null));

  // Deep-score with the LLM. `preview` is a synchronous dry-run (plan + cost, no LLM calls); the
  // POST starts a single-flight background job; status is polled like the scan job. All three
  // require an Anthropic key — a missing key returns 400 rather than starting.
  app.post("/api/score/preview", async (c) => {
    const options = await parseScoreOptions(c);
    try {
      const result = await previewScore(options);
      return c.json({ counts: result.counts, estimate: result.estimate });
    } catch (error) {
      if (error instanceof NoApiKeyError) return c.json({ error: error.message }, 400);
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/score", async (c) => {
    if (!repoHasAnthropicKey(repo)) {
      return c.json({ error: new NoApiKeyError().message }, 400);
    }
    const options = await parseScoreOptions(c);
    const started = scoreJobs.start(createScoreRun(options));
    return c.json(scoreJobs.getStatus(), started ? 202 : 409);
  });

  app.get("/api/score/status", (c) => c.json(scoreJobs.getStatus()));

  return app;
}

/** Whether a deep-score is possible: an Anthropic key is set (stored or via the env fallback). */
function repoHasAnthropicKey(repo: ServerDeps["repo"]): boolean {
  return Boolean(settingsWithEnvKey(repo).getSetting(ANTHROPIC_KEY_SETTING)?.trim());
}

/**
 * Parse deep-score options from the request body. `remoteOnly` defaults false; `limit` defaults to
 * `DEFAULT_SCORE_LIMIT` and is clamped to a positive integer. A malformed body is treated as "use
 * defaults" rather than an error, since both fields are optional.
 */
async function parseScoreOptions(c: {
  req: { json: () => Promise<unknown> };
}): Promise<ScoreRunOptions> {
  const body = await c.req.json().catch(() => null);
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const remoteOnly = record.remoteOnly === true;
  const rescore = record.rescore === true;
  const rawLimit = Number(record.limit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : DEFAULT_SCORE_LIMIT;
  return { remoteOnly, limit, rescore };
}

/** Parse the scan scope from the request body. Defaults to `"incremental"`; only `"full"` overrides
 *  it. A malformed body or unknown value uses the default. */
async function parseScanScope(c: {
  req: { json: () => Promise<unknown> };
}): Promise<"full" | "incremental"> {
  const body = await c.req.json().catch(() => null);
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  return record.scope === "full" ? "full" : "incremental";
}

const APPLICATION_TEXT_FIELDS = [
  "company",
  "role",
  "dateApplied",
  "url",
  "source",
  "salaryRange",
  "recruiter",
] as const;

/**
 * Pick the editable application fields out of a request body. Each present field must be a string
 * (or null, to clear an optional one); anything else is a 400. Unknown keys are ignored.
 */
function readApplicationFields(
  body: Record<string, unknown>,
): { ok: true; fields: ApplicationPatch } | { ok: false; error: string } {
  const fields: ApplicationPatch = {};
  for (const key of APPLICATION_TEXT_FIELDS) {
    const value = body[key];
    if (value === undefined) continue;
    if (value === null && key !== "company" && key !== "role" && key !== "dateApplied") {
      fields[key] = null;
      continue;
    }
    if (typeof value !== "string") return { ok: false, error: `"${key}" must be a string` };
    fields[key] = value;
  }
  return { ok: true, fields };
}

/** Application tracking: CRUD + status transitions + notes, over `repo.applications`. */
function registerApplicationRoutes(app: Hono, repo: ServerDeps["repo"]): void {
  const store = repo.applications;

  const parseId = (raw: string): number | undefined => {
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 && store.get(id) ? id : undefined;
  };
  const readBody = async (c: { req: { json: () => Promise<unknown> } }) => {
    const body = await c.req.json().catch(() => null);
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  };
  // Domain validation failures (bad date, empty name, illegal archive) are the caller's fault.
  const guard = <T>(fn: () => T): { ok: true; value: T } | { ok: false; error: string } => {
    try {
      return { ok: true, value: fn() };
    } catch (error) {
      if (error instanceof ApplicationError) return { ok: false, error: error.message };
      throw error;
    }
  };

  app.get("/api/applications", (c) => {
    const status = c.req.query("status");
    if (status !== undefined && !isApplicationStatus(status)) {
      return c.json({ error: `unknown status: ${status}` }, 400);
    }
    const search = c.req.query("search")?.trim();
    if (search) return c.json(store.search(search));
    return c.json(
      store.list({
        archived: c.req.query("archived") === "true",
        ...(status ? { status: status as ApplicationStatus } : {}),
      }),
    );
  });

  app.get("/api/applications/stats", (c) =>
    c.json({
      active: store.countsByStatus(),
      archived: store.countsByStatus({ archived: true }),
    }),
  );

  app.get("/api/applications/:id", (c) => {
    const id = parseId(c.req.param("id"));
    if (id === undefined) return c.json({ error: "application not found" }, 404);
    return c.json(store.get(id));
  });

  app.post("/api/applications", async (c) => {
    const body = await readBody(c);
    if (!body) return c.json({ error: "expected a JSON object body" }, 400);
    const read = readApplicationFields(body);
    if (!read.ok) return c.json({ error: read.error }, 400);
    const { company, role, ...rest } = read.fields;
    if (typeof company !== "string" || typeof role !== "string") {
      return c.json({ error: '"company" and "role" are required' }, 400);
    }
    if (body.postingId !== undefined && typeof body.postingId !== "string") {
      return c.json({ error: '"postingId" must be a string' }, 400);
    }
    const postingId = body.postingId as string | undefined;
    const input: NewApplication = { company, role, ...rest, postingId: postingId ?? null };
    const result = guard(() =>
      repo.transaction(() => {
        const created = store.add(input);
        // Mirror the match action so the posting leaves the default matches list.
        if (postingId) repo.setUserAction(postingId, "applied");
        return created;
      }),
    );
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(store.get(result.value.id), 201);
  });

  // Edit fields and/or move status in one call. A status change is logged as a dated note
  // (`statusDate`, default today), exactly like the CLI's `app status`.
  app.patch("/api/applications/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === undefined) return c.json({ error: "application not found" }, 404);
    const body = await readBody(c);
    if (!body) return c.json({ error: "expected a JSON object body" }, 400);
    const read = readApplicationFields(body);
    if (!read.ok) return c.json({ error: read.error }, 400);
    if (body.status !== undefined && !isApplicationStatus(body.status)) {
      return c.json({ error: `unknown status: ${String(body.status)}` }, 400);
    }
    if (body.statusDate !== undefined && typeof body.statusDate !== "string") {
      return c.json({ error: '"statusDate" must be a string' }, 400);
    }
    const result = guard(() =>
      repo.transaction(() => {
        store.update(id, read.fields);
        if (isApplicationStatus(body.status)) {
          store.setStatus(id, body.status, body.statusDate as string | undefined);
        }
        return store.get(id);
      }),
    );
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.value);
  });

  app.post("/api/applications/:id/notes", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === undefined) return c.json({ error: "application not found" }, 404);
    const body = await readBody(c);
    if (!body || typeof body.content !== "string") {
      return c.json({ error: 'expected { "content": string, "date"?: string }' }, 400);
    }
    if (body.date !== undefined && typeof body.date !== "string") {
      return c.json({ error: '"date" must be a string' }, 400);
    }
    const content = body.content;
    const date = body.date as string | undefined;
    const result = guard(() => store.addNote(id, content, date));
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(store.get(id), 201);
  });

  app.post("/api/applications/:id/archive", (c) => {
    const id = parseId(c.req.param("id"));
    if (id === undefined) return c.json({ error: "application not found" }, 404);
    const result = guard(() => store.archive(id));
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.value);
  });

  app.post("/api/applications/:id/unarchive", (c) => {
    const id = parseId(c.req.param("id"));
    if (id === undefined) return c.json({ error: "application not found" }, 404);
    return c.json(store.unarchive(id));
  });

  // --- Documents (notes in the DB, other files under the data dir's docs/ folder) ---

  app.get("/api/applications/:id/documents", (c) => {
    const id = parseId(c.req.param("id"));
    if (id === undefined) return c.json({ error: "application not found" }, 404);
    return c.json(repo.documents.list(id));
  });

  // Create (or replace, by name) a markdown note.
  app.post("/api/applications/:id/documents", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === undefined) return c.json({ error: "application not found" }, 404);
    const body = await readBody(c);
    if (!body || typeof body.name !== "string" || typeof body.content !== "string") {
      return c.json({ error: 'expected { "name": string, "content": string }' }, 400);
    }
    const { name, content } = body;
    const result = guard(() => repo.documents.saveNote(id, name, content));
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.value, 201);
  });

  // A note with its content; a file's metadata (its bytes come from /raw).
  app.get("/api/applications/:id/documents/:docId", (c) => {
    const id = parseId(c.req.param("id"));
    const docId = Number(c.req.param("docId"));
    const meta = id === undefined ? undefined : repo.documents.get(id, docId);
    if (id === undefined || !meta) return c.json({ error: "document not found" }, 404);
    return c.json(meta.kind === "note" ? repo.documents.getNote(id, docId) : meta);
  });

  app.put("/api/applications/:id/documents/:docId", async (c) => {
    const id = parseId(c.req.param("id"));
    const docId = Number(c.req.param("docId"));
    if (id === undefined || !repo.documents.get(id, docId)) {
      return c.json({ error: "document not found" }, 404);
    }
    const body = await readBody(c);
    if (!body || typeof body.content !== "string") {
      return c.json({ error: 'expected { "content": string }' }, 400);
    }
    const content = body.content;
    const result = guard(() => repo.documents.updateNote(id, docId, content));
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.value);
  });

  app.delete("/api/applications/:id/documents/:docId", (c) => {
    const id = parseId(c.req.param("id"));
    const docId = Number(c.req.param("docId"));
    if (id === undefined || !repo.documents.remove(id, docId)) {
      return c.json({ error: "document not found" }, 404);
    }
    return c.json({ removed: true });
  });

  // The document's bytes, for opening in a new tab or downloading.
  app.get("/api/applications/:id/documents/:docId/raw", (c) => {
    const id = parseId(c.req.param("id"));
    const doc =
      id === undefined ? undefined : repo.documents.read(id, Number(c.req.param("docId")));
    if (!doc) return c.json({ error: "document not found" }, 404);
    return new Response(new Uint8Array(doc.body), {
      headers: rawDocumentHeaders(doc.meta.name, doc.meta.mime),
    });
  });

  // Delete an application; a linked match is un-marked applied so it doesn't dangle.
  app.delete("/api/applications/:id", (c) => {
    const id = parseId(c.req.param("id"));
    if (id === undefined) return c.json({ error: "application not found" }, 404);
    const existing = store.get(id);
    repo.transaction(() => {
      store.remove(id);
      if (existing?.postingId) repo.clearUserAction(existing.postingId);
    });
    return c.json({ removed: true });
  });
}

/** Types a browser renders natively and safely without script: PDFs, raster images, text, JSON. */
const INLINE_SAFE =
  /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/(plain|markdown)|application\/json)\b/;

/**
 * Headers for serving a stored document. This server is same-origin with the dashboard's API, so
 * a document must never run script: `nosniff` stops content sniffing, and anything not known to be
 * inert (SVG, HTML, unknown binaries) is sandboxed by CSP and sent as a download.
 */
export function rawDocumentHeaders(name: string, mime: string): Record<string, string> {
  const filename = name.split("/").pop() ?? "document";
  const inline = INLINE_SAFE.test(mime);
  const headers: Record<string, string> = {
    "content-type": mime,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(filename)}`,
  };
  if (!inline) headers["content-security-policy"] = "sandbox; default-src 'none'";
  return headers;
}

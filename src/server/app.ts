import { readResumeBuffer } from "@app/profile/read-resume";
import { Hono } from "hono";
import type { ServerDeps } from "./types";

const ANTHROPIC_KEY_SETTING = "anthropicApiKey";
const MODEL_SETTING = "scorerModel";
const PROVIDER_SETTING = "scorerProvider";

// The Airtable directory URL is a fixed community resource (see `resolveShareUrl`), not user
// config, so it's intentionally absent from the settings API.

/** Settings shape returned to clients — the API key is never echoed back, only its presence. */
function readSettings(repo: ServerDeps["repo"]) {
  return {
    hasAnthropicKey: Boolean(repo.getSetting(ANTHROPIC_KEY_SETTING)?.trim()),
    scorerModel: repo.getSetting(MODEL_SETTING) ?? null,
    scorerProvider: repo.getSetting(PROVIDER_SETTING) ?? null,
  };
}

// Writable settings keys, mapped from request-body field → settings key. The API key is
// included here (write-only); reads go through `readSettings`, which masks it.
const WRITABLE_SETTINGS: Record<string, string> = {
  anthropicApiKey: ANTHROPIC_KEY_SETTING,
  scorerModel: MODEL_SETTING,
  scorerProvider: PROVIDER_SETTING,
};

/**
 * Build the local web app: a read API over the `Repository`, a streaming `POST /api/scan`, and
 * settings/resume writes. All dependencies are injected (`ServerDeps`) so every route handler is
 * unit-tested against an in-memory repo and a fake scan runner — no listening server, browser, or
 * network. The production listener and the real scan pipeline live in `serve.ts` (smoke-only).
 */
export function createApp(deps: ServerDeps): Hono {
  const { repo, jobs, runScan, buildProfileFromText } = deps;
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/matches", (c) => {
    const raw = c.req.query("minScore");
    const parsed = raw === undefined ? 0 : Number(raw);
    const minScore = Number.isFinite(parsed) ? parsed : 0;
    return c.json(repo.listScoredPostings(minScore));
  });

  app.get("/api/companies", (c) => c.json(repo.listTrackedCompanies()));

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
    try {
      if (contentType.includes("multipart/form-data")) {
        const body = await c.req.parseBody();
        const file = body.file;
        if (!(file instanceof File)) {
          return c.json({ error: 'expected a "file" upload field' }, 400);
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
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    const profile = buildProfileFromText(resumeText);
    repo.saveProfile(profile);
    return c.json(profile);
  });

  // Start a background scan (single-flight). 202 when started, 409 if one is already running.
  // Either way the body is the current job status, so the client can begin polling immediately.
  app.post("/api/scan", (c) => {
    const started = jobs.start(runScan);
    return c.json(jobs.getStatus(), started ? 202 : 409);
  });

  app.get("/api/scan/status", (c) => c.json(jobs.getStatus()));

  return app;
}

// Typed client for the job-hunter local server. Response shapes are defined as zod schemas and
// validated at the boundary in `request()`, so a server-side shape change surfaces as a thrown
// error on the first request rather than silently propagating `undefined` through the UI. Types
// are derived from the schemas via `z.infer`; they mirror `src/server` and the domain types and are
// kept in sync by hand (the server is a separate build target, so there's no shared import).

import { z } from "zod";

const JobPostingSchema = z.object({
  id: z.string(),
  company: z.string(),
  title: z.string(),
  url: z.string(),
  source: z.string(),
  description: z.string(),
  location: z.string().optional(),
  remote: z.boolean().optional(),
  country: z.string().optional(),
  postedAt: z.string().optional(),
  fetchedAt: z.string(),
});
export type JobPosting = z.infer<typeof JobPostingSchema>;

const MatchResultSchema = z.object({
  score: z.number(),
  matchedSkills: z.array(z.string()),
  missingSkills: z.array(z.string()),
  rationale: z.string().optional(),
});
export type MatchResult = z.infer<typeof MatchResultSchema>;

const UserActionSchema = z.enum(["saved", "dismissed", "applied"]);
export type UserAction = z.infer<typeof UserActionSchema>;

const ScoredPostingSchema = z.object({
  posting: JobPostingSchema,
  result: MatchResultSchema,
  action: UserActionSchema.nullable(),
  expired: z.boolean(),
});
export type ScoredPosting = z.infer<typeof ScoredPostingSchema>;

export type MatchFilters = {
  includeExpired?: boolean;
  includeDismissed?: boolean;
  remoteOnly?: boolean;
  country?: string;
  includeApplied?: boolean;
  onlyApplied?: boolean;
  search?: string;
};

const TrackedCompanySchema = z.object({ careersUrl: z.string(), name: z.string().optional() });
export type TrackedCompany = z.infer<typeof TrackedCompanySchema>;

const SkillSchema = z.object({ name: z.string(), category: z.string() });
export type Skill = z.infer<typeof SkillSchema>;

const CompanyRefSchema = z.object({ careersUrl: z.string(), name: z.string().optional() });
export type CompanyRef = z.infer<typeof CompanyRefSchema>;

const NeedsAttentionEntrySchema = z.object({
  careersUrl: z.string(),
  company: z.string(),
  message: z.string(),
  consecutiveFailures: z.number(),
});
export type NeedsAttentionEntry = z.infer<typeof NeedsAttentionEntrySchema>;

/** A finished scan's outcome: counts plus the directory delta vs. the previous scan. */
const ScanRecordSchema = z.object({
  id: z.number(),
  kind: z.enum(["full", "incremental", "retry"]),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  postingsSeen: z.number().nullable(),
  companiesSeen: z.number().nullable(),
  newCompanies: z.array(CompanyRefSchema),
  removedCompanies: z.array(CompanyRefSchema),
});
export type ScanRecord = z.infer<typeof ScanRecordSchema>;

const SkillProfileSchema = z.object({
  skills: z.array(z.string()),
  roleKeywords: z.array(z.string()),
  categories: z.array(z.string()),
  yearsExperience: z.number().optional(),
});
export type SkillProfile = z.infer<typeof SkillProfileSchema>;

// Mirrors the server's `readSettings` (src/server/app.ts): secret keys are reported by presence
// only, the feed URL is echoed back (not secret).
const SettingsViewSchema = z.object({
  hasAnthropicKey: z.boolean(),
  scorerModel: z.string().nullable(),
  scorerProvider: z.string().nullable(),
  homeCountry: z.string().nullable(),
  scanFreshnessHours: z.string().nullable(),
  hasTheMuseKey: z.boolean(),
  feedUrl: z.string().nullable(),
  hasFeedKey: z.boolean(),
});
export type SettingsView = z.infer<typeof SettingsViewSchema>;

// Mirrors the server's `WRITABLE_SETTINGS`. Secret keys (anthropicApiKey, theMuseApiKey, feedKey)
// are write-only; the server masks them on read.
export type SettingsUpdate = Partial<{
  anthropicApiKey: string;
  scorerModel: string;
  scorerProvider: string;
  homeCountry: string;
  scanFreshnessHours: string;
  theMuseApiKey: string;
  feedUrl: string;
  feedKey: string;
}>;

const ScanJobStateSchema = z.enum(["idle", "running", "done", "error"]);
export type ScanJobState = z.infer<typeof ScanJobStateSchema>;

/** Snapshot of the background scan, mirroring the server's `ScanJobStatus`. */
const ScanJobStatusSchema = z.object({
  state: ScanJobStateSchema,
  message: z.string().nullable(),
  current: z.number().nullable(),
  total: z.number().nullable(),
  count: z.number().nullable(),
  warnings: z.array(
    z.object({ source: z.string(), message: z.string(), careersUrl: z.string().optional() }),
  ),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  recent: z.array(z.string()),
});
export type ScanJobStatus = z.infer<typeof ScanJobStatusSchema>;

// Deep-score (LLM) — mirrors the server's ScoreStageCounts / CostEstimate / ScoreJobStatus.
const ScoreStageCountsSchema = z.object({
  inDb: z.number(),
  afterRemote: z.number(),
  afterHeuristic: z.number(),
  afterCap: z.number(),
  alreadyScoredSkipped: z.number(),
  triageTitles: z.number(),
  deepScored: z.number(),
  remotePenalized: z.number(),
});
export type ScoreStageCounts = z.infer<typeof ScoreStageCountsSchema>;

const CostEstimateSchema = z.object({
  triageTitles: z.number(),
  triageBatches: z.number(),
  deepScores: z.number(),
  triageUsd: z.number(),
  deepScoreUsd: z.number(),
  totalUsd: z.number(),
});
export type CostEstimate = z.infer<typeof CostEstimateSchema>;

const ScorePreviewSchema = z.object({
  counts: ScoreStageCountsSchema,
  estimate: CostEstimateSchema,
});
export type ScorePreview = z.infer<typeof ScorePreviewSchema>;

const ScoreJobStatusSchema = z.object({
  state: ScanJobStateSchema,
  message: z.string().nullable(),
  current: z.number().nullable(),
  total: z.number().nullable(),
  recent: z.array(z.string()),
  counts: ScoreStageCountsSchema.nullable(),
  estimate: CostEstimateSchema.nullable(),
  abortedOnLimit: z.boolean(),
  warnings: z.array(z.object({ source: z.string(), message: z.string() })),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type ScoreJobStatus = z.infer<typeof ScoreJobStatusSchema>;

/** Options a deep-score run accepts from the dashboard. */
export type ScoreOptions = { remoteOnly: boolean; limit: number; rescore: boolean };

const OkSchema = z.object({ ok: z.literal(true) });
const RemovedSchema = z.object({ removed: z.boolean() });
const VersionSchema = z.object({
  version: z.string(),
  behind: z.number().nullable(),
  updateAvailable: z.boolean(),
});
export type VersionInfo = z.infer<typeof VersionSchema>;

/**
 * Fetch `path` and validate the JSON body against `schema`. A non-2xx response throws with the
 * server's `error` message when present; a 2xx body that fails the schema throws a zod error,
 * turning silent client/server drift into a loud, first-request failure.
 */
async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    const message =
      detail && typeof detail === "object" && "error" in detail
        ? String((detail as { error: unknown }).error)
        : `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return schema.parse(await res.json());
}

export const api = {
  getMatches: (minScore: number, filters: MatchFilters = {}) => {
    const params = new URLSearchParams({ minScore: String(minScore) });
    if (filters.includeExpired) params.set("includeExpired", "true");
    if (filters.includeDismissed) params.set("includeDismissed", "true");
    if (filters.remoteOnly) params.set("remoteOnly", "true");
    if (filters.country) params.set("country", filters.country);
    if (filters.includeApplied) params.set("includeApplied", "true");
    if (filters.onlyApplied) params.set("onlyApplied", "true");
    if (filters.search) params.set("search", filters.search);
    return request(`/api/matches?${params}`, z.array(ScoredPostingSchema));
  },
  setMatchAction: (id: string, action: UserAction) =>
    request(`/api/matches/${encodeURIComponent(id)}/action`, OkSchema, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    }),
  clearMatchAction: (id: string) =>
    request(`/api/matches/${encodeURIComponent(id)}/action`, RemovedSchema, {
      method: "DELETE",
    }),
  getCompanies: () => request("/api/companies", z.array(TrackedCompanySchema)),
  getManualReviewCompanies: () =>
    request("/api/companies/manual-review", z.array(CompanyRefSchema)),
  getNeedsAttention: () =>
    request("/api/companies/needs-attention", z.array(NeedsAttentionEntrySchema)),
  addCompany: (careersUrl: string, name?: string) =>
    request("/api/companies", z.array(TrackedCompanySchema), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ careersUrl, name }),
    }),
  removeCompany: (careersUrl: string) =>
    request(`/api/companies?url=${encodeURIComponent(careersUrl)}`, RemovedSchema, {
      method: "DELETE",
    }),
  getProfile: () => request("/api/profile", SkillProfileSchema.nullable()),
  getSettings: () => request("/api/settings", SettingsViewSchema),
  putSettings: (update: SettingsUpdate) =>
    request("/api/settings", SettingsViewSchema, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    }),
  uploadResume: (file: File) => {
    const form = new FormData();
    form.set("file", file);
    return request("/api/profile", SkillProfileSchema, { method: "POST", body: form });
  },
  updateProfileSkills: (skills: string[]) =>
    request("/api/profile/skills", SkillProfileSchema, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skills }),
    }),
  getSkills: () => request("/api/skills", z.array(SkillSchema)),
  addSkill: (name: string, category?: string) =>
    request("/api/skills", z.array(SkillSchema), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, category }),
    }),
  removeSkill: (name: string) =>
    request(`/api/skills/${encodeURIComponent(name)}`, RemovedSchema, { method: "DELETE" }),
  // Start a background scan (or no-op if one is already running). Both 202 (started) and 409
  // (already running) carry the current job status, so neither is an error here. `scope` defaults
  // to "incremental" (skip companies checked recently); "full" re-visits every company.
  startScan: async (scope: "full" | "incremental" = "incremental"): Promise<ScanJobStatus> => {
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope }),
    });
    if (res.status === 202 || res.status === 409 || res.ok) {
      return ScanJobStatusSchema.parse(await res.json());
    }
    throw new Error(`${res.status} ${res.statusText}`);
  },
  // Same 202/409-both-ok semantics as startScan — either way the body is the current job status.
  retryFailedScan: async (): Promise<ScanJobStatus> => {
    const res = await fetch("/api/scan/retry-failed", { method: "POST" });
    if (res.status === 202 || res.status === 409 || res.ok) {
      return ScanJobStatusSchema.parse(await res.json());
    }
    throw new Error(`${res.status} ${res.statusText}`);
  },
  getScanStatus: () => request("/api/scan/status", ScanJobStatusSchema),
  getLatestScan: () => request("/api/scans/latest", ScanRecordSchema.nullable()),
  getVersion: () => request("/api/version", VersionSchema),
  // Deep-score with the LLM. `previewScore` is a synchronous dry-run (plan + cost, no LLM calls);
  // `startDeepScore` starts the single-flight background job (202/409 both carry the status).
  previewScore: (options: ScoreOptions) =>
    request("/api/score/preview", ScorePreviewSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options),
    }),
  startDeepScore: async (options: ScoreOptions): Promise<ScoreJobStatus> => {
    const res = await fetch("/api/score", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options),
    });
    if (res.status === 202 || res.status === 409) {
      return ScoreJobStatusSchema.parse(await res.json());
    }
    // A 400 (no key configured) or other error carries an { error } message.
    const detail = await res.json().catch(() => null);
    const message =
      detail && typeof detail === "object" && "error" in detail
        ? String((detail as { error: unknown }).error)
        : `${res.status} ${res.statusText}`;
    throw new Error(message);
  },
  getScoreStatus: () => request("/api/score/status", ScoreJobStatusSchema),
};

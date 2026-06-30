// Typed client for the job-hunter local server. Shapes mirror `src/server` and the domain types;
// kept in sync by hand (the server is a separate build target, so there's no shared import).

export type JobPosting = {
  id: string;
  company: string;
  title: string;
  url: string;
  source: string;
  description: string;
  location?: string;
  remote?: boolean;
  country?: string;
  postedAt?: string;
  fetchedAt: string;
};

export type MatchResult = {
  score: number;
  matchedSkills: string[];
  missingSkills: string[];
  rationale?: string;
};

export type UserAction = "saved" | "dismissed" | "applied";

export type ScoredPosting = {
  posting: JobPosting;
  result: MatchResult;
  action: UserAction | null;
  expired: boolean;
};

export type MatchFilters = {
  includeExpired?: boolean;
  includeDismissed?: boolean;
  remoteOnly?: boolean;
  country?: string;
  includeApplied?: boolean;
  onlyApplied?: boolean;
};

export type TrackedCompany = { careersUrl: string; name?: string };

export type Skill = { name: string; category: string };

export type CompanyRef = { careersUrl: string; name?: string };

/** A finished scan's outcome: counts plus the directory delta vs. the previous scan. */
export type ScanRecord = {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  postingsSeen: number | null;
  companiesSeen: number | null;
  newCompanies: CompanyRef[];
  removedCompanies: CompanyRef[];
};

export type SkillProfile = {
  skills: string[];
  roleKeywords: string[];
  categories: string[];
  yearsExperience?: number;
};

export type SettingsView = {
  hasAnthropicKey: boolean;
  scorerModel: string | null;
  scorerProvider: string | null;
};

export type SettingsUpdate = Partial<{
  anthropicApiKey: string;
  scorerModel: string;
  scorerProvider: string;
}>;

export type ScanJobState = "idle" | "running" | "done" | "error";

/** Snapshot of the background scan, mirroring the server's `ScanJobStatus`. */
export type ScanJobStatus = {
  state: ScanJobState;
  message: string | null;
  current: number | null;
  total: number | null;
  count: number | null;
  warnings: { source: string; message: string }[];
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  recent: string[];
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    const message =
      detail && typeof detail === "object" && "error" in detail
        ? String((detail as { error: unknown }).error)
        : `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return (await res.json()) as T;
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
    return request<ScoredPosting[]>(`/api/matches?${params}`);
  },
  setMatchAction: (id: string, action: UserAction) =>
    request<{ ok: true }>(`/api/matches/${encodeURIComponent(id)}/action`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    }),
  clearMatchAction: (id: string) =>
    request<{ removed: boolean }>(`/api/matches/${encodeURIComponent(id)}/action`, {
      method: "DELETE",
    }),
  getCompanies: () => request<TrackedCompany[]>("/api/companies"),
  getManualReviewCompanies: () => request<CompanyRef[]>("/api/companies/manual-review"),
  addCompany: (careersUrl: string, name?: string) =>
    request<TrackedCompany[]>("/api/companies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ careersUrl, name }),
    }),
  removeCompany: (careersUrl: string) =>
    request<{ removed: boolean }>(`/api/companies?url=${encodeURIComponent(careersUrl)}`, {
      method: "DELETE",
    }),
  getProfile: () => request<SkillProfile | null>("/api/profile"),
  getSettings: () => request<SettingsView>("/api/settings"),
  putSettings: (update: SettingsUpdate) =>
    request<SettingsView>("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    }),
  uploadResume: (file: File) => {
    const form = new FormData();
    form.set("file", file);
    return request<SkillProfile>("/api/profile", { method: "POST", body: form });
  },
  updateProfileSkills: (skills: string[]) =>
    request<SkillProfile>("/api/profile/skills", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skills }),
    }),
  getSkills: () => request<Skill[]>("/api/skills"),
  addSkill: (name: string, category?: string) =>
    request<Skill[]>("/api/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, category }),
    }),
  removeSkill: (name: string) =>
    request<{ removed: boolean }>(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" }),
  // Start a background scan (or no-op if one is already running). Both 202 (started) and 409
  // (already running) carry the current job status, so neither is an error here.
  startScan: async (): Promise<ScanJobStatus> => {
    const res = await fetch("/api/scan", { method: "POST" });
    if (res.status === 202 || res.status === 409 || res.ok) {
      return (await res.json()) as ScanJobStatus;
    }
    throw new Error(`${res.status} ${res.statusText}`);
  },
  getScanStatus: () => request<ScanJobStatus>("/api/scan/status"),
  getLatestScan: () => request<ScanRecord | null>("/api/scans/latest"),
  getVersion: () =>
    request<{ version: string; behind: number | null; updateAvailable: boolean }>("/api/version"),
};

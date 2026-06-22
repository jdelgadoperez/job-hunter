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
  postedAt?: string;
  fetchedAt: string;
};

export type MatchResult = {
  score: number;
  matchedSkills: string[];
  missingSkills: string[];
  rationale?: string;
};

export type ScoredPosting = { posting: JobPosting; result: MatchResult };

export type TrackedCompany = { careersUrl: string; name?: string };

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
  airtableShareUrl: string | null;
};

export type SettingsUpdate = Partial<{
  anthropicApiKey: string;
  scorerModel: string;
  scorerProvider: string;
  airtableShareUrl: string;
}>;

/** A scan progress event as emitted over SSE by `POST /api/scan`. */
export type ScanEvent =
  | { phase: "start" }
  | { phase: "log"; message: string }
  | { phase: "done"; count: number; warnings: { source: string; message: string }[] }
  | { phase: "error"; message: string };

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
  getMatches: (minScore: number) =>
    request<ScoredPosting[]>(`/api/matches?minScore=${encodeURIComponent(minScore)}`),
  getCompanies: () => request<TrackedCompany[]>("/api/companies"),
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
};

/**
 * Run a scan and invoke `onEvent` for each SSE progress event. Uses `fetch` (not `EventSource`,
 * which is GET-only) and parses the `event:`/`data:` stream by hand. Resolves when the stream ends.
 */
export async function runScan(onEvent: (event: ScanEvent) => void): Promise<void> {
  const res = await fetch("/api/scan", { method: "POST" });
  if (!res.body) throw new Error("scan stream unavailable");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flush = (chunk: string) => {
    // One SSE message per blank-line-delimited block; we only need its `data:` payload.
    for (const line of chunk.split("\n")) {
      if (line.startsWith("data:")) {
        try {
          onEvent(JSON.parse(line.slice(5).trim()) as ScanEvent);
        } catch {
          // Ignore keep-alives / non-JSON lines.
        }
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) flush(block);
  }
  if (buffer.trim()) flush(buffer);
}

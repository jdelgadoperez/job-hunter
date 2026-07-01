const SKILL_ALIASES: Record<string, string> = {
  "node.js": "node",
  nodejs: "node",
  "react.js": "react",
  reactjs: "react",
  postgres: "postgresql",
  ts: "typescript",
  js: "javascript",
};

export function normalizeSkill(raw: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return SKILL_ALIASES[cleaned] ?? cleaned;
}

/** The hostname of a URL with a leading `www.` stripped, or the input unchanged if unparseable. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Canonical form of a careers-page URL: origin + pathname only (no query string or fragment),
 * trailing slash stripped, lower-cased. Used both to de-duplicate leads in-memory and as the form
 * persisted for `tracked_companies`/`companies`, so the DB's `PRIMARY KEY` catches case/trailing-slash
 * variants of the same URL instead of storing them as distinct rows.
 */
export function normalizeCareersUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.replace(/\/$/, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

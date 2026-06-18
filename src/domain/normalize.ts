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

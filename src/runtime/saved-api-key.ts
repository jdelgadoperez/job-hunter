import { existsSync } from "node:fs";
import { ANTHROPIC_KEY_SETTING } from "@app/matching/settings-keys";
import Database from "better-sqlite3";
import { resolveDbPath } from "./paths";

export type AnthropicKeySource = "env" | "saved";

/**
 * The Anthropic API key for the opt-in `smoke:*` scripts: `ANTHROPIC_API_KEY` when set, otherwise
 * the key saved through the dashboard's Settings (the `anthropicApiKey` row in the local DB).
 *
 * The database is opened **read-only** and only if it already exists, so a smoke run never
 * creates, migrates or writes the user's data directory. Any failure to read it (no DB, an older
 * schema, a locked file) reads as "no saved key" — a smoke script then exits with its usual
 * "key not set" message instead of crashing.
 */
export function resolveAnthropicApiKey(
  opts: { env?: NodeJS.ProcessEnv; dbPath?: string } = {},
): { apiKey: string; source: AnthropicKeySource } | undefined {
  const env = opts.env ?? process.env;
  const fromEnv = env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv) return { apiKey: fromEnv, source: "env" };

  const dbPath = opts.dbPath ?? resolveDbPath({ env });
  if (!existsSync(dbPath)) return undefined;
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(ANTHROPIC_KEY_SETTING) as
      | { value: string }
      | undefined;
    const saved = row?.value.trim();
    return saved ? { apiKey: saved, source: "saved" } : undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

/** The one-line hint a smoke script prints when no key is available from either source. */
export const NO_ANTHROPIC_KEY_MESSAGE =
  "No Anthropic API key found — set ANTHROPIC_API_KEY or save one in the dashboard's Settings.";

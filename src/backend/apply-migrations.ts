import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "@app/net/error-message";
import type { Sql } from "postgres";

/** Absolute path to the committed migrations (repo root `supabase/migrations/`). */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));

/** Migration filenames are `<14-digit version>_<name>.sql` (the Supabase CLI convention). */
const MIGRATION_FILE = /^(\d{14})_(.+)\.sql$/;

export type Migration = { version: string; name: string; sql: string };

/**
 * Load the versioned migrations from disk, sorted by version (ascending) so they apply in order.
 * Pure but for the read; the directory is injectable for tests.
 */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations: Migration[] = [];
  for (const file of readdirSync(dir)) {
    const match = MIGRATION_FILE.exec(file);
    const version = match?.[1];
    const name = match?.[2];
    if (version === undefined || name === undefined) continue;
    migrations.push({ version, name, sql: readFileSync(join(dir, file), "utf8") });
  }
  return migrations.sort((a, b) => a.version.localeCompare(b.version));
}

/**
 * Self-heal the database: apply every migration not yet recorded in Supabase's migration ledger, in
 * version order, each in its own transaction, and record it so the ledger stays compatible with
 * `supabase db push` (both key off `version`). Runs on worker startup — so a fresh, rebuilt, or
 * drifted database is brought current on the next scan rather than crashing on a missing column, and
 * an up-to-date database is a no-op.
 *
 * Every migration is additive-idempotent (`add column if not exists` / `create index if not exists`),
 * so re-applying is safe even if a version is somehow half-recorded. A migration that throws aborts
 * the run (its transaction rolls back) — better to stop loudly than crawl into a half-migrated schema.
 * If the ledger itself can't be read (permissions, or a database predating the CLI) we log and skip
 * auto-migrate rather than block a possibly-healthy database.
 */
export async function applyPendingMigrations(
  sql: Sql,
  opts: { migrations?: Migration[]; log?: (message: string) => void } = {},
): Promise<string[]> {
  const migrations = opts.migrations ?? loadMigrations();
  const log = opts.log ?? console.log;

  let appliedVersions: Set<string>;
  try {
    const rows = await sql<{ version: string }[]>`
      SELECT version FROM supabase_migrations.schema_migrations`;
    appliedVersions = new Set(rows.map((row) => row.version));
  } catch (error) {
    log(
      `[scanner] could not read the migration ledger (${errorMessage(error)}); ` +
        "skipping auto-migrate.",
    );
    return [];
  }

  const pending = migrations.filter((m) => !appliedVersions.has(m.version));
  for (const migration of pending) {
    await sql.begin(async (tx) => {
      await tx.unsafe(migration.sql);
      await tx`
        INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
        VALUES (${migration.version}, ${migration.name}, ARRAY[${migration.sql}]::text[])`;
    });
    log(`[scanner] applied migration ${migration.version}_${migration.name}`);
  }
  return pending.map((m) => m.version);
}

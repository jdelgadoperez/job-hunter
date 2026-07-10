import { errorMessage } from "@app/net/error-message";
import type { Sql } from "postgres";

/**
 * The newest migration version the worker's code depends on. Bump this in lockstep with every new
 * `supabase/migrations/*.sql` file — `schema-version.test.ts` asserts it equals the latest migration
 * filename, so the two can't drift. The worker refuses to run against a database whose applied
 * migrations don't reach this version (see `assertSchemaVersion`).
 */
export const EXPECTED_SCHEMA_VERSION = "20260706023908";

/**
 * True when the database has applied a migration at least as new as `expected`. Supabase migration
 * versions are zero-padded `YYYYMMDDHHMMSS` timestamps, so a lexical `>=` on the max applied version
 * is a correct ordering. An empty ledger is never up to date.
 */
export function isSchemaUpToDate(applied: readonly string[], expected: string): boolean {
  if (applied.length === 0) return false;
  const max = applied.reduce((a, b) => (a >= b ? a : b));
  return max >= expected;
}

/**
 * Read the applied migration versions from Supabase's migration ledger and throw an actionable error
 * if the database is behind `EXPECTED_SCHEMA_VERSION`, BEFORE the worker touches any table. This
 * turns a cryptic mid-run `column "…" does not exist` into a clear "run the migrate workflow".
 *
 * Read-only: CI (`.github/workflows/migrate.yml`) owns applying migrations; the worker only verifies.
 * If the ledger itself can't be read (permissions, or a database that predates the CLI), we log and
 * continue rather than block a possibly-healthy database — a real schema gap still surfaces on the
 * first query, no worse than before this check existed.
 */
export async function assertSchemaVersion(
  sql: Sql,
  log: (message: string) => void = console.warn,
): Promise<void> {
  let applied: string[];
  try {
    const rows = await sql<{ version: string }[]>`
      SELECT version FROM supabase_migrations.schema_migrations`;
    applied = rows.map((row) => row.version);
  } catch (error) {
    log(
      `[scanner] could not read the migration ledger (${errorMessage(error)}); ` +
        "skipping the schema-version check.",
    );
    return;
  }
  if (!isSchemaUpToDate(applied, EXPECTED_SCHEMA_VERSION)) {
    const have = applied.length > 0 ? applied.reduce((a, b) => (a >= b ? a : b)) : "none";
    throw new Error(
      `Database schema is behind: latest applied migration is ${have}, but this build needs ` +
        `${EXPECTED_SCHEMA_VERSION}. Run the "migrate" workflow (GitHub → Actions → migrate → ` +
        "Run workflow) to apply pending migrations, then re-run.",
    );
  }
}

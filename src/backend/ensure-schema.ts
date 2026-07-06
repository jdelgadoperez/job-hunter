import { readFileSync } from "node:fs";
import type { Sql } from "postgres";

/** The idempotent Postgres schema, read once at module load (co-located `schema.sql`). */
const SCHEMA_SQL = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

/**
 * Apply `schema.sql` so the hosted worker self-heals a database that predates a column/index — or was
 * rebuilt behind the current schema — instead of crashing on the first query that references it (e.g.
 * `column "kind" of relation "scans" does not exist`). Every statement is `... if not exists` /
 * `drop ... if exists`, so re-running against an up-to-date database is a no-op.
 *
 * `sql.unsafe` with no bind parameters uses the simple query protocol, which runs the whole
 * multi-statement file in a single round-trip. Requires the service-role connection (DDL bypasses
 * RLS). Mirrors the local SQLite `Repository.migrate()` additive-column self-heal.
 */
export function ensureSchema(sql: Sql): Promise<unknown> {
  return sql.unsafe(SCHEMA_SQL);
}

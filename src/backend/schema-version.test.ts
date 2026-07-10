import { readdirSync } from "node:fs";
import type { Sql } from "postgres";
import { describe, expect, test } from "vitest";
import { assertSchemaVersion, EXPECTED_SCHEMA_VERSION, isSchemaUpToDate } from "./schema-version";

describe("isSchemaUpToDate", () => {
  test("true when the newest applied version reaches the expected one", () => {
    expect(isSchemaUpToDate(["20260627222515", "20260706023908"], "20260706023908")).toBe(true);
    // A version newer than expected (unordered input) still counts.
    expect(isSchemaUpToDate(["20270101000000", "20260627222515"], "20260706023908")).toBe(true);
  });

  test("false when every applied version is older than expected", () => {
    expect(isSchemaUpToDate(["20260627222515"], "20260706023908")).toBe(false);
  });

  test("false for an empty ledger", () => {
    expect(isSchemaUpToDate([], "20260706023908")).toBe(false);
  });
});

/** Minimal fake of porsager's tagged-template `sql` returning fixed rows (or throwing). */
function fakeSql(result: { version: string }[] | Error) {
  return (() =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result)) as unknown as Sql;
}

describe("assertSchemaVersion", () => {
  test("resolves when the database is up to date", async () => {
    const sql = fakeSql([{ version: "20260627222515" }, { version: EXPECTED_SCHEMA_VERSION }]);
    await expect(assertSchemaVersion(sql, () => {})).resolves.toBeUndefined();
  });

  test("throws an actionable error when the database is behind", async () => {
    const sql = fakeSql([{ version: "20260627222515" }]);
    await expect(assertSchemaVersion(sql, () => {})).rejects.toThrow(/schema is behind.*migrate/is);
  });

  test("logs and continues when the migration ledger can't be read", async () => {
    const logged: string[] = [];
    const sql = fakeSql(new Error("permission denied for schema supabase_migrations"));
    await expect(assertSchemaVersion(sql, (m) => logged.push(m))).resolves.toBeUndefined();
    expect(logged[0]).toMatch(/could not read the migration ledger/);
  });
});

describe("EXPECTED_SCHEMA_VERSION", () => {
  test("matches the newest migration file (kept in lockstep so the worker guard can't lag)", () => {
    const dir = new URL("../../supabase/migrations/", import.meta.url);
    const versions = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.slice(0, 14));
    expect(versions.length).toBeGreaterThan(0);
    const newest = versions.reduce((a, b) => (a >= b ? a : b));
    expect(EXPECTED_SCHEMA_VERSION).toBe(newest);
  });
});

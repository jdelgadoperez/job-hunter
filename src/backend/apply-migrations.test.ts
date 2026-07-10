import type { Sql } from "postgres";
import { describe, expect, test } from "vitest";
import { applyPendingMigrations, loadMigrations, type Migration } from "./apply-migrations";

/**
 * Fake of porsager's `sql` for the applier: the tagged template answers the ledger SELECT and records
 * INSERTs; `sql.begin` runs the callback with a tx that shares the same behavior plus `unsafe`, which
 * captures the applied migration SQL. `readError` makes the ledger SELECT reject.
 */
function fakeSql(appliedVersions: string[], readError?: Error) {
  const events = { ranSql: [] as string[], recorded: [] as string[] };
  const tag = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join(" ");
    if (text.includes("SELECT version FROM")) {
      return readError
        ? Promise.reject(readError)
        : Promise.resolve(appliedVersions.map((version) => ({ version })));
    }
    if (text.includes("INSERT INTO supabase_migrations")) {
      events.recorded.push(String(values[0]));
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  const unsafe = (sqlText: string) => {
    events.ranSql.push(sqlText);
    return Promise.resolve([]);
  };
  const begin = async (fn: (tx: unknown) => Promise<unknown>) => fn(Object.assign(tag, { unsafe }));
  return { sql: Object.assign(tag, { unsafe, begin }) as unknown as Sql, events };
}

const MIGRATIONS: Migration[] = [
  { version: "20260627222515", name: "baseline", sql: "create table a();" },
  { version: "20260706023908", name: "sync", sql: "alter table a add column b int;" },
];

describe("applyPendingMigrations", () => {
  test("applies only the migrations missing from the ledger, and records them", async () => {
    const { sql, events } = fakeSql(["20260627222515"]);
    const applied = await applyPendingMigrations(sql, { migrations: MIGRATIONS, log: () => {} });

    expect(applied).toEqual(["20260706023908"]);
    expect(events.ranSql).toEqual(["alter table a add column b int;"]);
    expect(events.recorded).toEqual(["20260706023908"]);
  });

  test("is a no-op when every migration is already applied", async () => {
    const { sql, events } = fakeSql(["20260627222515", "20260706023908"]);
    const applied = await applyPendingMigrations(sql, { migrations: MIGRATIONS, log: () => {} });

    expect(applied).toEqual([]);
    expect(events.ranSql).toEqual([]);
    expect(events.recorded).toEqual([]);
  });

  test("applies all when the ledger is empty (fresh/rebuilt database), in version order", async () => {
    const { sql, events } = fakeSql([]);
    const applied = await applyPendingMigrations(sql, { migrations: MIGRATIONS, log: () => {} });

    expect(applied).toEqual(["20260627222515", "20260706023908"]);
    expect(events.recorded).toEqual(["20260627222515", "20260706023908"]);
  });

  test("logs and skips (returns []) when the migration ledger can't be read", async () => {
    const logged: string[] = [];
    const { sql, events } = fakeSql(
      [],
      new Error("permission denied for schema supabase_migrations"),
    );
    const applied = await applyPendingMigrations(sql, {
      migrations: MIGRATIONS,
      log: (m) => logged.push(m),
    });

    expect(applied).toEqual([]);
    expect(events.ranSql).toEqual([]);
    expect(logged[0]).toMatch(/could not read the migration ledger/);
  });
});

describe("loadMigrations", () => {
  test("reads the committed migrations, version-sorted, matching the ledger the DB expects", () => {
    const migrations = loadMigrations();
    const versions = migrations.map((m) => m.version);
    expect(versions).toEqual(["20260627222515", "20260706023908"]);
    // Each carries real SQL (the applier runs `sql` verbatim).
    expect(migrations.every((m) => m.sql.length > 0)).toBe(true);
  });
});

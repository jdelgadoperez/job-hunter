import type { Sql } from "postgres";
import { describe, expect, test } from "vitest";
import { ensureSchema } from "./ensure-schema";

/** Minimal fake of porsager's `sql` capturing raw `unsafe` calls (the only method ensureSchema uses). */
function fakeSql() {
  const unsafeCalls: string[] = [];
  const fn = Object.assign(() => Promise.resolve([]), {
    unsafe: (text: string) => {
      unsafeCalls.push(text);
      return Promise.resolve([]);
    },
    unsafeCalls,
  });
  return fn;
}

describe("ensureSchema", () => {
  test("runs the idempotent schema, including the columns recent stores can be missing", async () => {
    const sql = fakeSql();
    await ensureSchema(sql as unknown as Sql);

    expect(sql.unsafeCalls).toHaveLength(1);
    const applied = sql.unsafeCalls[0] ?? "";
    // The whole schema is one multi-statement string. Assert on the additive migrations that a
    // drifted DB is missing — the `scans.kind` column is exactly what broke the worker.
    expect(applied).toContain("alter table scans add column if not exists kind");
    expect(applied).toContain("create table if not exists scans");
    // Every statement must be idempotent so re-running on a current DB is a no-op.
    expect(applied).not.toMatch(/create table (?!if not exists)/);
  });
});

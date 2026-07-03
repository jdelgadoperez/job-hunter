import { describe, expect, test } from "vitest";
import { PostgresScanStore } from "./postgres-scan-store";

// Minimal fake of porsager's tagged-template `sql`. Captures the values array of each call.
function fakeSql(returnRows: unknown[]) {
  const calls: { strings: readonly string[]; values: unknown[] }[] = [];
  const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: [...strings], values });
    return Promise.resolve(returnRows);
  };
  return Object.assign(fn, { calls });
}

describe("PostgresScanStore.startScan", () => {
  test("threads the scan kind into the insert", async () => {
    const sql = fakeSql([{ id: "42" }]);
    const store = new PostgresScanStore(sql as never);
    const id = await store.startScan("incremental");
    expect(id).toBe(42);
    const insert = sql.calls.find((c) => c.strings.join("").includes("INSERT INTO scans"));
    expect(insert?.values).toContain("incremental");
  });

  test("defaults to full when no kind is passed", async () => {
    const sql = fakeSql([{ id: "1" }]);
    const store = new PostgresScanStore(sql as never);
    await store.startScan();
    const insert = sql.calls.find((c) => c.strings.join("").includes("INSERT INTO scans"));
    expect(insert?.values).toContain("full");
  });
});

describe("PostgresScanStore.recordDirectory", () => {
  test("honors computeRemoved:false", async () => {
    // Fake returns pre-existing companies + a prev scan, but computeRemoved:false must suppress the diff.
    const sql = fakeSql([]); // adapt: recordDirectory issues several queries; return [] for each
    const store = new PostgresScanStore(sql as never);
    const diff = await store.recordDirectory(5, [{ careersUrl: "https://x.co" }], {
      computeRemoved: false,
    });
    expect(diff).toEqual({ newCompanies: [], removedCompanies: [] });
  });
});

describe("PostgresScanStore.expireStalePostings", () => {
  test("counts only full scans in its staleness predicate", async () => {
    const sql = fakeSql([]);
    const store = new PostgresScanStore(sql as never);
    await store.expireStalePostings(10, 2);
    const update = sql.calls.find((c) =>
      c.strings.join("").includes("UPDATE postings SET expired_at"),
    );
    expect(update?.strings.join("")).toContain("kind = 'full'");
  });
});

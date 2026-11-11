import { describe, expect, test } from "vitest";
import { PostgresScanStore } from "./postgres-scan-store";

// Minimal fake of porsager's tagged-template `sql`. Captures the values array of each call.
// `responses` is either a single array shared by every call (legacy, most tests) or a function
// that inspects the query text and returns rows tailored to that specific call.
function fakeSql(responses: unknown[] | ((sqlText: string) => unknown[])) {
  const calls: { strings: readonly string[]; values: unknown[] }[] = [];
  const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: [...strings], values });
    const rows = typeof responses === "function" ? responses(strings.join("")) : responses;
    return Promise.resolve(rows);
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
    // Fake returns a pre-existing company (so isBaseline is false) and a prev scan id that matches
    // that company's last_seen_scan (so it's a removed-diff candidate). The companies arg below both
    // omits that existing company (removed candidate) and adds a new one (new-company candidate), so
    // if computeRemoved were not gating the diff, both newCompanies and removedCompanies would be
    // non-empty. The empty result is achievable only via the `!computeRemoved` branch.
    const sql = fakeSql((sqlText) => {
      if (sqlText.includes("SELECT careers_url, name, last_seen_scan FROM companies")) {
        return [{ careers_url: "https://existing.co", name: "Existing", last_seen_scan: "3" }];
      }
      if (sqlText.includes("SELECT MAX(id) AS id FROM scans")) {
        return [{ id: "3" }];
      }
      // Chunked upsert into companies.
      return [];
    });
    const store = new PostgresScanStore(sql as never);
    const diff = await store.recordDirectory(5, [{ careersUrl: "https://new.co" }], {
      computeRemoved: false,
    });
    expect(diff).toEqual({ newCompanies: [], removedCompanies: [] });
  });
});

describe("PostgresScanStore.expireStalePostings", () => {
  test("counts only finished full scans in its staleness predicate", async () => {
    const sql = fakeSql([]);
    const store = new PostgresScanStore(sql as never);
    await store.expireStalePostings(10, 2);
    const update = sql.calls.find((c) =>
      c.strings.join("").includes("UPDATE postings SET expired_at"),
    );
    const query = update?.strings.join("") ?? "";
    expect(query).toContain("kind = 'full'");
    // A crashed/unfinished scan (finished_at IS NULL) must not advance the staleness clock — parity
    // with the SQLite Repository, so a worker that crashes twice can't expire live postings.
    expect(query).toContain("finished_at IS NOT NULL");
  });
});

describe("PostgresScanStore.pruneExpiredPostings", () => {
  test("deletes only postings expired longer than the retention window", async () => {
    const sql = fakeSql(Object.assign([], { count: 7 }));
    const store = new PostgresScanStore(sql as never);
    const pruned = await store.pruneExpiredPostings(30);
    expect(pruned).toBe(7);
    const del = sql.calls.find((c) => c.strings.join("").includes("DELETE FROM postings"));
    const query = del?.strings.join("") ?? "";
    // Live postings (expired_at IS NULL) must never be touched — they are the feed.
    expect(query).toContain("expired_at IS NOT NULL");
    expect(query).toContain("make_interval(days =>");
    expect(del?.values).toEqual([30]);
  });

  test.each([0, -1, Number.NaN])("is a no-op when retention is %s", async (days) => {
    const sql = fakeSql([]);
    const store = new PostgresScanStore(sql as never);
    expect(await store.pruneExpiredPostings(days)).toBe(0);
    expect(sql.calls).toHaveLength(0);
  });
});

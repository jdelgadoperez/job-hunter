import { describe, expect, it } from "vitest";
import { FakeSharedViewReader } from "./airtable";
import { AirtableSource } from "./airtable-source";
import type { LeadSourceDeps } from "./types";

/** Minimal deps; the Airtable source only touches sharedViewReader + shareUrl. */
function deps(reader: FakeSharedViewReader): LeadSourceDeps {
  return {
    fetcher: { fetch: async () => ({ statusCode: 200, finalUrl: "", bodyText: "" }) },
    settings: { getSetting: () => undefined },
    sharedViewReader: reader,
    shareUrl: "https://airtable.test/share",
  };
}

/** A minimal shared-view payload with one row that maps to a lead. */
const sharedView = {
  data: {
    primaryColumnId: "c1",
    columns: [
      { id: "c1", name: "Company" },
      { id: "c2", name: "Jobs Page" },
    ],
    rows: [{ cellValuesByColumnId: { c1: "Acme", c2: "https://boards.greenhouse.io/acme" } }],
  },
};

describe("AirtableSource", () => {
  it("maps the shared view to leads with no warnings on success", async () => {
    const source = new AirtableSource();
    const result = await source.fetch(deps(new FakeSharedViewReader(sharedView)));

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.careersUrl).toBe("https://boards.greenhouse.io/acme");
    expect(result.warnings).toEqual([]);
  });

  it("degrades to empty leads + a warning when the reader throws", async () => {
    const source = new AirtableSource();
    const error = new Error("network down");
    const result = await source.fetch(deps(new FakeSharedViewReader(error)));

    expect(result.leads).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.source).toBe("airtable");
    expect(result.warnings[0]?.message).toContain("network down");
  });

  it("surfaces the mapper's warning (e.g. unexpected shape) without throwing", async () => {
    const source = new AirtableSource();
    const result = await source.fetch(deps(new FakeSharedViewReader({ data: {} })));

    expect(result.leads).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.source).toBe("airtable");
  });
});

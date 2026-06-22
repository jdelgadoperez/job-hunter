import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/airtable-shared-view.json";
import { FakeSharedViewReader, airtableRowsToLeads } from "./airtable";

describe("airtableRowsToLeads", () => {
  it("maps rows to leads, reading company from the primary column and url from Jobs Page", () => {
    const { leads, warning } = airtableRowsToLeads(fixture);
    expect(warning).toBeUndefined();
    expect(leads).toEqual([
      { company: "Acme", careersUrl: "https://boards.greenhouse.io/acme", categories: [] },
      { company: "Globex", careersUrl: "https://jobs.lever.co/globex", categories: [] },
    ]);
  });

  it("skips rows that have no careers URL", () => {
    const { leads } = airtableRowsToLeads(fixture);
    expect(leads.map((l) => l.company)).not.toContain("NoUrlCo");
  });

  it("accepts rows nested under data.rows as well as data.table.rows", () => {
    const raw = {
      data: {
        table: { columns: [{ id: "c1", name: "Jobs Page" }] },
        rows: [{ cellValuesByColumnId: { c1: "https://x.com/careers" } }],
      },
    };
    const { leads } = airtableRowsToLeads(raw);
    expect(leads).toEqual([
      { company: "x.com", careersUrl: "https://x.com/careers", categories: [] },
    ]);
  });

  it("warns when the careers-URL column is missing", () => {
    const raw = { data: { table: { columns: [{ id: "c1", name: "Company" }], rows: [] } } };
    const result = airtableRowsToLeads(raw);
    expect(result.leads).toEqual([]);
    expect(result.warning).toContain("Jobs Page");
  });

  it("warns on an unexpected response shape rather than throwing", () => {
    const result = airtableRowsToLeads({ totally: "wrong" });
    expect(result.leads).toEqual([]);
    expect(result.warning).toBe("unexpected Airtable shared-view response shape");
  });

  it("honors custom field-name overrides", () => {
    const raw = {
      data: {
        table: {
          columns: [
            { id: "c1", name: "Name" },
            { id: "c2", name: "Careers" },
          ],
          rows: [{ cellValuesByColumnId: { c1: "Initech", c2: "https://initech.com/careers" } }],
        },
      },
    };
    const { leads } = airtableRowsToLeads(raw, {
      companyField: "Name",
      careersUrlField: "Careers",
    });
    expect(leads).toEqual([
      { company: "Initech", careersUrl: "https://initech.com/careers", categories: [] },
    ]);
  });
});

describe("FakeSharedViewReader", () => {
  it("returns its canned response", async () => {
    const reader = new FakeSharedViewReader(fixture);
    await expect(reader.read("ignored")).resolves.toBe(fixture);
  });

  it("throws when configured with an error", async () => {
    const reader = new FakeSharedViewReader(new Error("offline"));
    await expect(reader.read("ignored")).rejects.toThrow("offline");
  });
});

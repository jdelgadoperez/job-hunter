import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "./__fixtures__/airtable-shared-view.json";
import {
  COMMUNITY_SHARE_URL,
  FakeSharedViewReader,
  airtableRowsToLeads,
  resolveShareUrl,
} from "./airtable";

describe("resolveShareUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns the fixed community table by default", () => {
    vi.stubEnv("AIRTABLE_SHARE_URL", undefined);
    expect(resolveShareUrl()).toBe(COMMUNITY_SHARE_URL);
  });

  it("honors the AIRTABLE_SHARE_URL dev override (trimmed)", () => {
    vi.stubEnv("AIRTABLE_SHARE_URL", "  https://airtable.com/other  ");
    expect(resolveShareUrl()).toBe("https://airtable.com/other");
  });

  it("falls back to the community table when the override is blank", () => {
    vi.stubEnv("AIRTABLE_SHARE_URL", "   ");
    expect(resolveShareUrl()).toBe(COMMUNITY_SHARE_URL);
  });
});

describe("airtableRowsToLeads", () => {
  it("maps rows to leads, reading company from the primary column and url from Jobs Page", () => {
    const { leads, warning } = airtableRowsToLeads(fixture);
    expect(warning).toBeUndefined();
    expect(leads).toEqual([
      { company: "Acme", careersUrl: "https://boards.greenhouse.io/acme", categories: [] },
      { company: "Globex", careersUrl: "https://jobs.lever.co/globex", categories: [] },
    ]);
  });

  it("maps the real Airtable shape: columns/rows under data, button-cell url, primaryColumnId", () => {
    // Mirrors a real readSharedViewData capture: no `data.table` wrapper, and the "Jobs Page"
    // button cell carries the URL as `{ label, url }`.
    const raw = {
      msg: "SUCCESS",
      data: {
        primaryColumnId: "fldCompany",
        columns: [
          { id: "fldCompany", name: "Company Name", type: "text" },
          { id: "fldJobs", name: "Jobs Page", type: "button" },
          { id: "fldCity", name: "HQ City", type: "text" },
        ],
        rows: [
          {
            id: "rec1",
            cellValuesByColumnId: {
              fldCompany: "EDB",
              fldJobs: { label: "Open", url: "https://www.enterprisedb.com/careers/job-openings" },
              fldCity: "Wilmington",
            },
          },
        ],
      },
    };
    const { leads, warning } = airtableRowsToLeads(raw);
    expect(warning).toBeUndefined();
    expect(leads).toEqual([
      {
        company: "EDB",
        careersUrl: "https://www.enterprisedb.com/careers/job-openings",
        categories: [],
      },
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

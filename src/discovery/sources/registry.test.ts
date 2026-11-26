import { describe, expect, it } from "vitest";
import { LEAD_SOURCES, personalOnly, sharedOnly } from "./registry";
import type { LeadSource } from "./types";

describe("lead source registry", () => {
  it("lists the sources in dedup precedence order (Airtable first as the canonical directory)", () => {
    expect(LEAD_SOURCES.map((s) => s.name)).toEqual(["airtable", "remotive", "themuse"]);
  });

  it("keeps The Muse personal: never in the shared set the hosted worker publishes", () => {
    expect(sharedOnly(LEAD_SOURCES).map((s) => s.name)).toEqual(["airtable", "remotive"]);
    expect(personalOnly(LEAD_SOURCES).map((s) => s.name)).toEqual(["themuse"]);
  });

  it("splits any source list by the personal flag, preserving order", () => {
    const fake = (name: string, personal?: boolean): LeadSource => ({
      name,
      ...(personal !== undefined ? { personal } : {}),
      fetch: async () => ({ leads: [], warnings: [] }),
    });
    const sources = [fake("a"), fake("b", true), fake("c", false), fake("d", true)];
    expect(sharedOnly(sources).map((s) => s.name)).toEqual(["a", "c"]);
    expect(personalOnly(sources).map((s) => s.name)).toEqual(["b", "d"]);
  });
});

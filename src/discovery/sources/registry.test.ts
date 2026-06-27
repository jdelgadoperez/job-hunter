import { describe, expect, it } from "vitest";
import { LEAD_SOURCES } from "./registry";

describe("LEAD_SOURCES", () => {
  it("lists the sources in dedup precedence order (Airtable first as the canonical directory)", () => {
    expect(LEAD_SOURCES.map((s) => s.name)).toEqual(["airtable", "remotive", "themuse"]);
  });
});

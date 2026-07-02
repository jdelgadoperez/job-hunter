import { describe, expect, it } from "vitest";
import { makeCompanyId } from "./company-id";

describe("makeCompanyId", () => {
  it("is a 16-char lowercase hex string", () => {
    const id = makeCompanyId("https://boards.greenhouse.io/acme");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic for the same URL", () => {
    const url = "https://boards.greenhouse.io/acme";
    expect(makeCompanyId(url)).toBe(makeCompanyId(url));
  });

  it("collapses URL variants that normalize to the same canonical form", () => {
    // normalizeCareersUrl lowercases, strips trailing slash, drops query/fragment.
    const canonical = makeCompanyId("https://boards.greenhouse.io/acme");
    expect(makeCompanyId("https://boards.greenhouse.io/acme/")).toBe(canonical);
    expect(makeCompanyId("https://Boards.Greenhouse.io/acme?utm=x")).toBe(canonical);
  });

  it("differs for genuinely different companies", () => {
    expect(makeCompanyId("https://boards.greenhouse.io/acme")).not.toBe(
      makeCompanyId("https://boards.greenhouse.io/other"),
    );
  });
});

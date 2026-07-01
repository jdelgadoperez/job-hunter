import { describe, expect, it } from "vitest";
import type { JobPosting } from "./api";
import { companyDisplayName, companyLinks } from "./company-links";

const basePosting: JobPosting = {
  id: "1",
  company: "acme-corp",
  title: "Engineer",
  url: "https://boards.greenhouse.io/acmecorp/jobs/123",
  source: "greenhouse",
  description: "",
  fetchedAt: "2026-07-01T00:00:00Z",
};

describe("companyDisplayName", () => {
  it("de-slugs a hyphenated board token into spaced words", () => {
    expect(companyDisplayName("acme-corp")).toBe("Acme Corp");
  });

  it("strips a trailing legal/HQ suffix", () => {
    expect(companyDisplayName("globex-robotics-inc")).toBe("Globex Robotics");
    expect(companyDisplayName("initech-llc")).toBe("Initech");
    expect(companyDisplayName("umbrella-hq")).toBe("Umbrella");
  });

  it("collapses whitespace and title-cases an already-readable name", () => {
    expect(companyDisplayName("  Hooli   Inc ")).toBe("Hooli");
  });

  it("leaves a single clean word title-cased", () => {
    expect(companyDisplayName("stripe")).toBe("Stripe");
  });

  it("preserves existing internal capitals instead of lowercasing real names", () => {
    // Browser-sourced postings carry a real display name, not a slug — don't mangle its casing.
    expect(companyDisplayName("IBM")).toBe("IBM");
    expect(companyDisplayName("eBay")).toBe("eBay");
    expect(companyDisplayName("PostgreSQL")).toBe("PostgreSQL");
  });
});

describe("companyLinks", () => {
  const byKey = (posting: JobPosting) =>
    Object.fromEntries(companyLinks(posting).map((l) => [l.key, l.href]));

  it("returns the four link keys in a stable order", () => {
    expect(companyLinks(basePosting).map((l) => l.key)).toEqual([
      "website",
      "glassdoor",
      "linkedin",
      "crunchbase",
    ]);
  });

  it("builds Glassdoor, LinkedIn and Crunchbase searches from the normalized name", () => {
    const links = byKey(basePosting);
    const encoded = encodeURIComponent("Acme Corp");
    expect(links.glassdoor).toBe(`https://www.glassdoor.com/Search/results.htm?keyword=${encoded}`);
    expect(links.linkedin).toBe(
      `https://www.linkedin.com/search/results/companies/?keywords=${encoded}`,
    );
    expect(links.crunchbase).toBe(
      `https://duckduckgo.com/?q=${encodeURIComponent("Acme Corp site:crunchbase.com")}`,
    );
  });

  it("uses the posting's own domain as the website for browser-sourced postings", () => {
    const browserPosting: JobPosting = {
      ...basePosting,
      source: "browser",
      company: "Acme Corp",
      url: "https://www.acme.com/careers/eng-123",
    };
    expect(byKey(browserPosting).website).toBe("https://acme.com");
  });

  it("falls back to a scoped search for the website when the posting is ATS-sourced", () => {
    // greenhouse url points at the ATS, not the company site, so website must be a search.
    expect(byKey(basePosting).website).toBe(
      `https://duckduckgo.com/?q=${encodeURIComponent("Acme Corp")}`,
    );
  });

  it("percent-encodes names with spaces and ampersands safely", () => {
    const messy: JobPosting = { ...basePosting, source: "browser", company: "Ben & Jerry's" };
    const links = byKey(messy);
    expect(links.glassdoor).toContain(encodeURIComponent("Ben & Jerry's"));
    expect(links.glassdoor).not.toContain(" ");
    expect(links.glassdoor).not.toContain("&k");
  });
});

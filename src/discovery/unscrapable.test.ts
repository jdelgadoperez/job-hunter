import { describe, expect, it } from "vitest";
import { isUnscrapableHost } from "./unscrapable";

describe("isUnscrapableHost", () => {
  it("flags LinkedIn, Indeed, and Glassdoor (incl. subdomains)", () => {
    for (const url of [
      "https://www.linkedin.com/company/acme/jobs/",
      "https://linkedin.com/jobs/view/123",
      "https://www.indeed.com/cmp/acme/jobs",
      "https://uk.indeed.com/jobs",
      "https://www.glassdoor.com/Jobs/acme",
    ]) {
      expect(isUnscrapableHost(url)).toBe(true);
    }
  });

  it("allows real ATS / company careers hosts", () => {
    for (const url of [
      "https://boards.greenhouse.io/acme",
      "https://jobs.lever.co/acme",
      "https://acme.com/careers",
      "https://genesys.wd1.myworkdayjobs.com/Genesys",
      // not a substring trap: a host that merely contains the word but isn't the domain
      "https://notlinkedin.example.com/jobs",
    ]) {
      expect(isUnscrapableHost(url)).toBe(false);
    }
  });

  it("returns false for an unparseable URL", () => {
    expect(isUnscrapableHost("not a url")).toBe(false);
  });
});

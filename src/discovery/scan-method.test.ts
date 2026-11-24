import { describe, expect, it } from "vitest";
import { scanMethod } from "./scan-method";

describe("scanMethod", () => {
  it("names the ATS connector for a known board", () => {
    expect(scanMethod("https://boards.greenhouse.io/acme")).toBe("greenhouse");
    expect(scanMethod("https://jobs.lever.co/acme")).toBe("lever");
  });

  it("marks hosts we don't scrape as manual", () => {
    expect(scanMethod("https://www.linkedin.com/company/acme/jobs")).toBe("manual");
  });

  it("falls back to the browser for any other page", () => {
    expect(scanMethod("https://acme.com/careers")).toBe("browser");
    expect(scanMethod("not a url")).toBe("browser");
  });
});

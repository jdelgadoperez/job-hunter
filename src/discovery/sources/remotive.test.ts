import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Fetcher } from "@app/net/fetcher";
import { describe, expect, it } from "vitest";
import { RemotiveSource } from "./remotive";
import type { LeadSourceDeps } from "./types";

const FIXTURE = readFileSync(join(__dirname, "__fixtures__", "remotive-jobs.json"), "utf8");

/** A Fetcher returning a canned body + status, ignoring the URL. */
function fetcherReturning(bodyText: string, statusCode = 200): Fetcher {
  return { fetch: async () => ({ statusCode, finalUrl: "", bodyText }) };
}

function deps(fetcher: Fetcher): LeadSourceDeps {
  return {
    fetcher,
    settings: { getSetting: () => undefined },
    sharedViewReader: { read: async () => ({}) },
    shareUrl: "",
  };
}

describe("RemotiveSource", () => {
  it("emits one lead per job, mapping company/url/category", async () => {
    const jobs = (
      JSON.parse(FIXTURE) as { jobs: { company_name: string; url: string; category: string }[] }
    ).jobs;
    const source = new RemotiveSource();

    const result = await source.fetch(deps(fetcherReturning(FIXTURE)));

    expect(result.leads).toHaveLength(jobs.length);
    expect(result.leads.map((l) => l.careersUrl)).toEqual(jobs.map((j) => j.url));
    expect(result.leads[0]?.company).toBe(jobs[0]?.company_name);
    expect(result.leads[0]?.categories).toEqual([jobs[0]?.category]);
    expect(result.warnings).toEqual([]);
  });

  it("degrades to a warning on a non-2xx response", async () => {
    const source = new RemotiveSource();
    const result = await source.fetch(deps(fetcherReturning("", 503)));

    expect(result.leads).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.source).toBe("remotive");
  });

  it("degrades to a warning on a malformed payload", async () => {
    const source = new RemotiveSource();
    const result = await source.fetch(deps(fetcherReturning('{"unexpected":true}')));

    expect(result.leads).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.source).toBe("remotive");
  });
});

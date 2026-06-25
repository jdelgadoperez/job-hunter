import { FakeFetcher } from "@app/net/fetcher";
import { describe, expect, it } from "vitest";
import { makePostingId } from "../posting-id";
import { WorkdayConnector, parseWorkdayUrl } from "./workday";

const CAREERS = "https://genesys.wd1.myworkdayjobs.com/Genesys";
const API = "https://genesys.wd1.myworkdayjobs.com/wday/cxs/genesys/Genesys/jobs";

const FEED = JSON.stringify({
  total: 2,
  jobPostings: [
    {
      title: "Senior Software Engineer",
      externalPath: "/job/Remote/Senior-Software-Engineer_JR-100",
      locationsText: "Remote, US",
    },
    { title: "Product Manager", externalPath: "/job/NYC/Product-Manager_JR-101" },
  ],
});

describe("parseWorkdayUrl", () => {
  it("extracts host/tenant/site, ignoring a locale prefix", () => {
    expect(parseWorkdayUrl(CAREERS)).toEqual({
      host: "genesys.wd1.myworkdayjobs.com",
      tenant: "genesys",
      site: "Genesys",
    });
    expect(
      parseWorkdayUrl("https://paloaltonetworks.wd5.myworkdayjobs.com/en-US/panwexternalcareers"),
    ).toEqual({
      host: "paloaltonetworks.wd5.myworkdayjobs.com",
      tenant: "paloaltonetworks",
      site: "panwexternalcareers",
    });
  });

  it("returns null for non-Workday or unparseable URLs", () => {
    expect(parseWorkdayUrl("https://boards.greenhouse.io/acme")).toBeNull();
    expect(parseWorkdayUrl("not a url")).toBeNull();
  });
});

describe("WorkdayConnector", () => {
  it("maps the CXS jobs feed into normalized postings", async () => {
    const fetcher = new FakeFetcher({
      [API]: { statusCode: 200, finalUrl: API, bodyText: FEED },
    });

    const result = await new WorkdayConnector().fetchPostings(CAREERS, fetcher);
    if (!result.ok) throw new Error(`expected ok, got: ${result.warning}`);

    expect(result.postings).toHaveLength(2);
    const [first, second] = result.postings;
    expect(first?.source).toBe("workday");
    expect(first?.company).toBe("genesys");
    expect(first?.title).toBe("Senior Software Engineer");
    expect(first?.url).toBe(
      "https://genesys.wd1.myworkdayjobs.com/Genesys/job/Remote/Senior-Software-Engineer_JR-100",
    );
    expect(first?.location).toBe("Remote, US");
    expect(first?.description).toContain("Remote, US");
    expect(first?.id).toBe(
      makePostingId({ company: "genesys", title: first?.title ?? "", url: first?.url ?? "" }),
    );
    // A posting with no locationsText still gets a title-based description.
    expect(second?.description).toBe("Product Manager");
  });

  it("warns for an unrecognized Workday URL", async () => {
    const result = await new WorkdayConnector().fetchPostings(
      "https://x.com/y",
      new FakeFetcher({}),
    );
    expect(result.ok).toBe(false);
  });

  it("fails (not empty) for a malformed feed", async () => {
    const fetcher = new FakeFetcher({
      [API]: { statusCode: 200, finalUrl: API, bodyText: '{"jobPostings":[{"nope":true}]}' },
    });
    expect(await new WorkdayConnector().fetchPostings(CAREERS, fetcher)).toEqual({
      ok: false,
      warning: "response failed schema validation",
    });
  });

  it("fails for a non-200 status", async () => {
    const fetcher = new FakeFetcher({
      [API]: { statusCode: 500, finalUrl: API, bodyText: "" },
    });
    expect((await new WorkdayConnector().fetchPostings(CAREERS, fetcher)).ok).toBe(false);
  });
});

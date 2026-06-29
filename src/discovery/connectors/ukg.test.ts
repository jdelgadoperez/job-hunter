import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FakeFetcher } from "@app/net/fetcher";
import { describe, expect, it } from "vitest";
import { makePostingId } from "../posting-id";
import { parseUkgUrl, UkgConnector } from "./ukg";

const CAREERS =
  "https://recruiting2.ultipro.com/SUP1002SPRM/JobBoard/7f7ebf9e-d3a1-4d1a-83da-0de093cee244/?q=&o=postedDateDesc";
const TENANT = "SUP1002SPRM";
const GUID = "7f7ebf9e-d3a1-4d1a-83da-0de093cee244";
const API = `https://recruiting2.ultipro.com/${TENANT}/JobBoard/${GUID}/JobBoardView/LoadSearchResults`;

async function fixtureBody(): Promise<string> {
  const path = fileURLToPath(new URL("./__fixtures__/ukg-list.json", import.meta.url));
  return readFile(path, "utf8");
}

describe("parseUkgUrl", () => {
  it("extracts origin/tenant/jobBoardId from a UKG careers URL", () => {
    expect(parseUkgUrl(CAREERS)).toEqual({
      origin: "https://recruiting2.ultipro.com",
      tenant: TENANT,
      jobBoardId: GUID,
    });
  });

  it("returns null for non-UKG or unparseable URLs", () => {
    expect(parseUkgUrl("https://boards.greenhouse.io/acme")).toBeNull();
    expect(parseUkgUrl("https://recruiting.ultipro.com/onlytenant")).toBeNull();
    expect(parseUkgUrl("not a url")).toBeNull();
  });
});

describe("UkgConnector", () => {
  it("maps the search results, using BriefDescription as the description", async () => {
    const body = await fixtureBody();
    const feed = JSON.parse(body) as {
      opportunities: {
        Id: string;
        Title: string;
        BriefDescription: string;
        Locations: { LocalizedDescription: string }[];
      }[];
    };
    const firstOpp = feed.opportunities[0];
    if (!firstOpp) throw new Error("fixture must have at least one opportunity");

    const fetcher = new FakeFetcher({
      [API]: { statusCode: 200, finalUrl: API, bodyText: body },
    });

    const result = await new UkgConnector().fetchPostings(CAREERS, fetcher);
    if (!result.ok) throw new Error(`expected ok, got: ${result.warning}`);

    expect(result.postings).toHaveLength(feed.opportunities.length);
    const [first] = result.postings;
    const expectedUrl = `https://recruiting2.ultipro.com/${TENANT}/JobBoard/${GUID}/OpportunityDetail?opportunityId=${firstOpp.Id}`;
    expect(first?.source).toBe("ukg");
    expect(first?.company).toBe(TENANT);
    expect(first?.title).toBe(firstOpp.Title);
    expect(first?.url).toBe(expectedUrl);
    expect(first?.description).toBe(firstOpp.BriefDescription.trim());
    expect(first?.location).toBe(firstOpp.Locations[0]?.LocalizedDescription);
    expect(first?.id).toBe(
      makePostingId({ company: TENANT, title: firstOpp.Title, url: expectedUrl }),
    );
  });

  it("warns for an unrecognized UKG URL", async () => {
    const result = await new UkgConnector().fetchPostings("https://x.com/y", new FakeFetcher({}));
    expect(result.ok).toBe(false);
  });

  it("fails (not empty) for a malformed feed", async () => {
    const fetcher = new FakeFetcher({
      [API]: { statusCode: 200, finalUrl: API, bodyText: '{"opportunities":[{"nope":true}]}' },
    });
    expect(await new UkgConnector().fetchPostings(CAREERS, fetcher)).toEqual({
      ok: false,
      warning: "response failed schema validation",
    });
  });

  it("fails for a non-200 status", async () => {
    const fetcher = new FakeFetcher({
      [API]: { statusCode: 500, finalUrl: API, bodyText: "" },
    });
    expect((await new UkgConnector().fetchPostings(CAREERS, fetcher)).ok).toBe(false);
  });
});

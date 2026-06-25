import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FakeFetcher } from "@app/net/fetcher";
import { describe, expect, it } from "vitest";
import { makePostingId } from "../posting-id";
import { RecruiteeConnector } from "./recruitee";

const SLUG = "petalmd";
const ENDPOINT = `https://${SLUG}.recruitee.com/api/offers/`;

async function fixtureBody(): Promise<string> {
  const path = fileURLToPath(new URL("./__fixtures__/recruitee.json", import.meta.url));
  return readFile(path, "utf8");
}

describe("RecruiteeConnector", () => {
  it("maps the offers feed into normalized postings (description comes from the list)", async () => {
    const body = await fixtureBody();
    type Offer = { title: string; careers_url: string; description: string; location: string };
    const offers = (JSON.parse(body) as { offers: Offer[] }).offers;
    const firstOffer = offers[0];
    if (!firstOffer) throw new Error("fixture must have at least one offer");

    const fetcher = new FakeFetcher({
      [ENDPOINT]: { statusCode: 200, finalUrl: ENDPOINT, bodyText: body },
    });

    const result = await new RecruiteeConnector().fetchPostings(SLUG, fetcher);
    if (!result.ok) throw new Error(`expected ok, got: ${result.warning}`);

    expect(result.postings).toHaveLength(offers.length);
    const [first] = result.postings;
    expect(first?.source).toBe("recruitee");
    expect(first?.company).toBe(SLUG);
    expect(first?.title).toBe(firstOffer.title);
    expect(first?.url).toBe(firstOffer.careers_url);
    expect(first?.location).toBe(firstOffer.location);
    expect(first?.description).toBe(firstOffer.description);
    expect(first?.id).toBe(
      makePostingId({ company: SLUG, title: firstOffer.title, url: firstOffer.careers_url }),
    );
    expect(first?.fetchedAt).toBeInstanceOf(Date);
  });

  it("fails (not empty) for a malformed feed", async () => {
    const fetcher = new FakeFetcher({
      [ENDPOINT]: { statusCode: 200, finalUrl: ENDPOINT, bodyText: '{"offers":[{"nope":true}]}' },
    });
    expect(await new RecruiteeConnector().fetchPostings(SLUG, fetcher)).toEqual({
      ok: false,
      warning: "response failed schema validation",
    });
  });

  it("fails for a non-200 status", async () => {
    const fetcher = new FakeFetcher({
      [ENDPOINT]: { statusCode: 503, finalUrl: ENDPOINT, bodyText: "" },
    });
    expect((await new RecruiteeConnector().fetchPostings(SLUG, fetcher)).ok).toBe(false);
  });
});

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FakeFetcher } from "@app/net/fetcher";
import { describe, expect, it } from "vitest";
import { makePostingId } from "../posting-id";
import { SmartRecruitersConnector } from "./smartrecruiters";

const SLUG = "Freshworks";
const LIST = `https://api.smartrecruiters.com/v1/companies/${SLUG}/postings?limit=100&offset=0`;
const detailUrl = (id: string) =>
  `https://api.smartrecruiters.com/v1/companies/${SLUG}/postings/${id}`;

async function fixture(name: string): Promise<string> {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return readFile(path, "utf8");
}

describe("SmartRecruitersConnector", () => {
  it("maps the list and pulls each posting's description + canonical url from its detail", async () => {
    const listBody = await fixture("smartrecruiters-list.json");
    const detailBody = await fixture("smartrecruiters-detail.json");
    const list = JSON.parse(listBody) as {
      content: { id: string; name: string; location: { fullLocation: string } }[];
    };
    const detail = JSON.parse(detailBody) as {
      postingUrl: string;
      jobAd: { sections: { jobDescription: { text: string }; qualifications: { text: string } } };
    };

    const [firstItem, secondItem] = list.content;
    if (!firstItem || !secondItem) throw new Error("fixture must have at least two postings");

    const fetcher = new FakeFetcher({
      [LIST]: { statusCode: 200, finalUrl: LIST, bodyText: listBody },
      // First posting has a detail; the second's 404s to exercise the fallback.
      [detailUrl(firstItem.id)]: {
        statusCode: 200,
        finalUrl: detailUrl(firstItem.id),
        bodyText: detailBody,
      },
    });

    const result = await new SmartRecruitersConnector().fetchPostings(SLUG, fetcher);
    if (!result.ok) throw new Error(`expected ok, got: ${result.warning}`);

    expect(result.postings).toHaveLength(list.content.length);
    const first = result.postings.find((p) => p.title === firstItem.name);
    expect(first?.source).toBe("smartrecruiters");
    expect(first?.company).toBe(SLUG);
    expect(first?.location).toBe(firstItem.location.fullLocation);
    // url is the canonical postingUrl from the detail response.
    expect(first?.url).toBe(detail.postingUrl);
    // description joins the jobDescription + qualifications section text.
    expect(first?.description).toContain(detail.jobAd.sections.jobDescription.text.trim());
    expect(first?.description).toContain(detail.jobAd.sections.qualifications.text.trim());
    expect(first?.id).toBe(
      makePostingId({ company: SLUG, title: firstItem.name, url: detail.postingUrl }),
    );

    // The second posting's detail 404s, so it falls back to title + location and a synthesized url.
    const second = result.postings.find((p) => p.title === secondItem.name);
    expect(second?.url).toBe(`https://jobs.smartrecruiters.com/${SLUG}/${secondItem.id}`);
    expect(second?.description).toBe(`${secondItem.name} — ${secondItem.location.fullLocation}`);
  });

  it("fails (not empty) for a malformed list feed", async () => {
    const fetcher = new FakeFetcher({
      [LIST]: { statusCode: 200, finalUrl: LIST, bodyText: '{"content":[{"nope":true}]}' },
    });
    expect(await new SmartRecruitersConnector().fetchPostings(SLUG, fetcher)).toEqual({
      ok: false,
      warning: "response failed schema validation",
    });
  });

  it("fails for a non-200 list status", async () => {
    const fetcher = new FakeFetcher({
      [LIST]: { statusCode: 500, finalUrl: LIST, bodyText: "" },
    });
    expect((await new SmartRecruitersConnector().fetchPostings(SLUG, fetcher)).ok).toBe(false);
  });
});

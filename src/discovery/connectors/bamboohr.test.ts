import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FakeFetcher } from "@app/net/fetcher";
import { describe, expect, it } from "vitest";
import { makePostingId } from "../posting-id";
import { BambooHrConnector } from "./bamboohr";

const SLUG = "avidbots";
const LIST = `https://${SLUG}.bamboohr.com/careers/list`;
const detailUrl = (id: string) => `https://${SLUG}.bamboohr.com/careers/${id}/detail`;

async function fixture(name: string): Promise<string> {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return readFile(path, "utf8");
}

describe("BambooHrConnector", () => {
  it("maps the list and pulls each posting's description + share url from its detail", async () => {
    const listBody = await fixture("bamboohr-list.json");
    const detailBody = await fixture("bamboohr-detail.json");
    const list = JSON.parse(listBody) as {
      result: { id: string; jobOpeningName: string; atsLocation: Record<string, string> }[];
    };
    const detail = JSON.parse(detailBody) as {
      result: { jobOpening: { description: string; jobOpeningShareUrl: string } };
    };

    const [firstJob, secondJob] = list.result;
    if (!firstJob || !secondJob) throw new Error("fixture must have at least two jobs");

    const fetcher = new FakeFetcher({
      [LIST]: { statusCode: 200, finalUrl: LIST, bodyText: listBody },
      // First job has a detail; the second's 404s to exercise the fallback.
      [detailUrl(firstJob.id)]: {
        statusCode: 200,
        finalUrl: detailUrl(firstJob.id),
        bodyText: detailBody,
      },
    });

    const result = await new BambooHrConnector().fetchPostings(SLUG, fetcher);
    if (!result.ok) throw new Error(`expected ok, got: ${result.warning}`);

    expect(result.postings).toHaveLength(list.result.length);
    const opening = detail.result.jobOpening;
    const first = result.postings.find((p) => p.title === firstJob.jobOpeningName);
    expect(first?.source).toBe("bamboohr");
    expect(first?.company).toBe(SLUG);
    expect(first?.url).toBe(opening.jobOpeningShareUrl);
    expect(first?.description).toBe(opening.description.trim());
    // Location is the joined atsLocation parts.
    expect(first?.location).toContain(firstJob.atsLocation.city);
    expect(first?.id).toBe(
      makePostingId({
        company: SLUG,
        title: firstJob.jobOpeningName,
        url: opening.jobOpeningShareUrl,
      }),
    );
    expect(first?.fetchedAt).toBeInstanceOf(Date);

    // The second job's detail 404s, so it falls back to a synthesized URL + title-based description.
    const second = result.postings.find((p) => p.title === secondJob.jobOpeningName);
    expect(second?.url).toBe(`https://${SLUG}.bamboohr.com/careers/${secondJob.id}`);
    expect(second?.description).toContain(secondJob.jobOpeningName);
  });

  it("omits the location for a job with no atsLocation", async () => {
    const listBody = JSON.stringify({
      result: [{ id: "42", jobOpeningName: "Remote Engineer" }],
    });
    const fetcher = new FakeFetcher({
      [LIST]: { statusCode: 200, finalUrl: LIST, bodyText: listBody },
      // No detail route → 404 → title-only fallback (no location to append).
    });

    const result = await new BambooHrConnector().fetchPostings(SLUG, fetcher);
    if (!result.ok) throw new Error(`expected ok, got: ${result.warning}`);
    const [posting] = result.postings;
    expect(posting?.location).toBeUndefined();
    expect(posting?.description).toBe("Remote Engineer");
  });

  it("fails (not empty) for a malformed list feed", async () => {
    const fetcher = new FakeFetcher({
      [LIST]: { statusCode: 200, finalUrl: LIST, bodyText: '{"result":[{"nope":true}]}' },
    });
    expect(await new BambooHrConnector().fetchPostings(SLUG, fetcher)).toEqual({
      ok: false,
      warning: "response failed schema validation",
    });
  });

  it("fails for a non-200 list status", async () => {
    const fetcher = new FakeFetcher({
      [LIST]: { statusCode: 500, finalUrl: LIST, bodyText: "" },
    });
    expect((await new BambooHrConnector().fetchPostings(SLUG, fetcher)).ok).toBe(false);
  });
});

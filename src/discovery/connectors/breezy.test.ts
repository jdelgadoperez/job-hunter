import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FakeFetcher } from "@app/net/fetcher";
import { describe, expect, it } from "vitest";
import { makePostingId } from "../posting-id";
import { BreezyConnector } from "./breezy";
import { extractJsonLdDescription } from "./jsonld";

const SLUG = "superdispatch";
const LIST = `https://${SLUG}.breezy.hr/json`;

async function fixture(name: string): Promise<string> {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return readFile(path, "utf8");
}

describe("BreezyConnector", () => {
  it("maps the list and reads each posting's description from its position-page JSON-LD", async () => {
    const listBody = await fixture("breezy-list.json");
    const positionHtml = await fixture("breezy-position.html");
    const list = JSON.parse(listBody) as {
      name: string;
      url: string;
      location: { name: string };
    }[];

    const [firstJob, secondJob] = list;
    if (!firstJob || !secondJob) throw new Error("fixture must have at least two jobs");

    const fetcher = new FakeFetcher({
      [LIST]: { statusCode: 200, finalUrl: LIST, bodyText: listBody },
      // First position page resolves; the second's 404s to exercise the fallback.
      [firstJob.url]: { statusCode: 200, finalUrl: firstJob.url, bodyText: positionHtml },
    });

    const result = await new BreezyConnector().fetchPostings(SLUG, fetcher);
    if (!result.ok) throw new Error(`expected ok, got: ${result.warning}`);

    expect(result.postings).toHaveLength(list.length);
    const expectedDescription = extractJsonLdDescription(positionHtml);
    expect(expectedDescription).toBeTruthy();

    const first = result.postings.find((p) => p.title === firstJob.name);
    expect(first?.source).toBe("breezy");
    expect(first?.company).toBe(SLUG);
    expect(first?.url).toBe(firstJob.url);
    expect(first?.location).toBe(firstJob.location.name);
    expect(first?.description).toBe(expectedDescription);
    expect(first?.id).toBe(
      makePostingId({ company: SLUG, title: firstJob.name, url: firstJob.url }),
    );

    // The second position page 404s, so it falls back to title + location.
    const second = result.postings.find((p) => p.title === secondJob.name);
    expect(second?.description).toBe(`${secondJob.name} — ${secondJob.location.name}`);
  });

  it("falls back to title + location when a position-page fetch throws", async () => {
    const listBody = await fixture("breezy-list.json");
    const list = JSON.parse(listBody) as { name: string; location: { name: string } }[];
    const [firstJob] = list;
    if (!firstJob) throw new Error("fixture must have at least one job");

    // A fetcher that serves the list but throws on every position-page fetch.
    const throwingFetcher = {
      async fetch(url: string) {
        if (url === LIST) return { statusCode: 200, finalUrl: LIST, bodyText: listBody };
        throw new Error("network down");
      },
    };

    const result = await new BreezyConnector().fetchPostings(SLUG, throwingFetcher);
    if (!result.ok) throw new Error(`expected ok, got: ${result.warning}`);
    const first = result.postings.find((p) => p.title === firstJob.name);
    expect(first?.description).toBe(`${firstJob.name} — ${firstJob.location.name}`);
  });

  it("fails (not empty) for a malformed list feed", async () => {
    const fetcher = new FakeFetcher({
      [LIST]: { statusCode: 200, finalUrl: LIST, bodyText: '[{"nope":true}]' },
    });
    expect(await new BreezyConnector().fetchPostings(SLUG, fetcher)).toEqual({
      ok: false,
      warning: "response failed schema validation",
    });
  });

  it("fails for a non-200 list status", async () => {
    const fetcher = new FakeFetcher({
      [LIST]: { statusCode: 503, finalUrl: LIST, bodyText: "" },
    });
    expect((await new BreezyConnector().fetchPostings(SLUG, fetcher)).ok).toBe(false);
  });
});

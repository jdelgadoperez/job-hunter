import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FakeFetcher } from "@app/net/fetcher";
import { describe, expect, it } from "vitest";
import { makePostingId } from "../posting-id";
import { RipplingConnector } from "./rippling";

const SLUG = "just-appraised-jobs";
const LIST = `https://ats.rippling.com/api/v2/board/${SLUG}/jobs?page=0&pageSize=50`;

async function fixture(name: string): Promise<string> {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return readFile(path, "utf8");
}

/** Expected values are read from the same fixtures the connector parses, never hand-copied. */
async function fixtureJson(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fixture(name));
}

describe("RipplingConnector", () => {
  it("maps the list feed and pulls each posting's full description from its detail endpoint", async () => {
    const listBody = await fixture("rippling-list.json");
    const detailBody = await fixture("rippling-detail.json");
    const list = await fixtureJson("rippling-list.json");
    const detail = await fixtureJson("rippling-detail.json");

    const items = list.items as { id: string; name: string; url: string }[];
    const firstItem = items[0];
    const secondItem = items[1];
    if (!firstItem || !secondItem) throw new Error("fixture must have at least two items");
    const detailUrl = (id: string) => `https://ats.rippling.com/api/v2/board/${SLUG}/jobs/${id}`;

    const fetcher = new FakeFetcher({
      [LIST]: { statusCode: 200, finalUrl: LIST, bodyText: listBody },
      // First job has a detail page; the second's is missing (404) to exercise the fallback.
      [detailUrl(firstItem.id)]: {
        statusCode: 200,
        finalUrl: detailUrl(firstItem.id),
        bodyText: detailBody,
      },
    });

    const result = await new RipplingConnector().fetchPostings(SLUG, fetcher);
    if (!result.ok) throw new Error(`expected ok, got: ${result.warning}`);

    expect(result.postings).toHaveLength(items.length);
    const [first, second] = result.postings;
    expect(first?.source).toBe("rippling");
    expect(first?.company).toBe(SLUG);
    expect(first?.title).toBe(firstItem.name);
    expect(first?.url).toBe(firstItem.url);
    expect(first?.location).toBe("Remote (United States)");
    // Description comes from the detail endpoint's `description.role`.
    const role = (detail.description as { role: string }).role;
    expect(first?.description).toBe(role.trim());
    expect(first?.id).toBe(
      makePostingId({ company: SLUG, title: firstItem.name, url: firstItem.url }),
    );
    expect(first?.fetchedAt).toBeInstanceOf(Date);
    // The second job's detail 404s, so it falls back to a title + location description.
    expect(second?.description).toBe(`${secondItem.name} — Remote (United States)`);
  });

  it("pages through multiple list pages and handles a job with no locations", async () => {
    const page = (n: number) =>
      `https://ats.rippling.com/api/v2/board/${SLUG}/jobs?page=${n}&pageSize=50`;
    const detailUrl = (id: string) => `https://ats.rippling.com/api/v2/board/${SLUG}/jobs/${id}`;
    const job = (id: string, name: string, locations: { name: string }[]) => ({
      id,
      name,
      url: `https://ats.rippling.com/${SLUG}/jobs/${id}`,
      locations,
    });

    const page0 = JSON.stringify({
      items: [job("a", "Engineer", [{ name: "Remote" }])],
      totalPages: 2,
    });
    // Second page's job has no locations, so its detail fallback is title-only.
    const page1 = JSON.stringify({ items: [job("b", "Designer", [])], totalPages: 2 });

    const fetcher = new FakeFetcher({
      [page(0)]: { statusCode: 200, finalUrl: page(0), bodyText: page0 },
      [page(1)]: { statusCode: 200, finalUrl: page(1), bodyText: page1 },
      // No detail routes registered → both 404 → both fall back.
    });

    const result = await new RipplingConnector().fetchPostings(SLUG, fetcher);
    if (!result.ok) throw new Error(`expected ok, got: ${result.warning}`);

    expect(result.postings).toHaveLength(2);
    const designer = result.postings.find((p) => p.title === "Designer");
    expect(designer?.location).toBeUndefined();
    expect(designer?.description).toBe("Designer");
    const engineer = result.postings.find((p) => p.title === "Engineer");
    expect(engineer?.description).toBe("Engineer — Remote");
  });

  it("fails (not empty) for a malformed list feed", async () => {
    const fetcher = new FakeFetcher({
      [LIST]: { statusCode: 200, finalUrl: LIST, bodyText: '{"items":[{"nope":true}]}' },
    });
    expect(await new RipplingConnector().fetchPostings(SLUG, fetcher)).toEqual({
      ok: false,
      warning: "response failed schema validation",
    });
  });

  it("fails for a non-200 list status", async () => {
    const fetcher = new FakeFetcher({
      [LIST]: { statusCode: 500, finalUrl: LIST, bodyText: "" },
    });
    expect((await new RipplingConnector().fetchPostings(SLUG, fetcher)).ok).toBe(false);
  });
});

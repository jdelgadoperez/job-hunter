import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makePostingId } from "../posting-id";
import { extractJsonLdDescription, extractJsonLdPostings } from "./jsonld";

async function fixtureHtml(): Promise<string> {
  const path = fileURLToPath(new URL("./__fixtures__/jobposting.html", import.meta.url));
  return readFile(path, "utf8");
}

const PAGE_URL = "https://acme.com/careers";

describe("extractJsonLdPostings", () => {
  it("extracts a JobPosting nested in @graph, skipping malformed blocks", async () => {
    const postings = extractJsonLdPostings(await fixtureHtml(), PAGE_URL, "Acme");

    expect(postings).toHaveLength(1);
    const [posting] = postings;
    expect(posting?.title).toBe("Machine Learning Engineer");
    expect(posting?.description).toContain("Python");
    expect(posting?.url).toBe("https://acme.com/careers/ml-engineer");
    expect(posting?.location).toBe("Remote");
    expect(posting?.source).toBe("browser");
    expect(posting?.id).toBe(
      makePostingId({ company: "Acme", title: posting?.title ?? "", url: posting?.url ?? "" }),
    );
  });

  it("returns [] for a page with no JSON-LD", () => {
    expect(extractJsonLdPostings("<html><body>no data</body></html>", PAGE_URL, "Acme")).toEqual(
      [],
    );
  });

  it("falls back to the page url when the posting omits its own url", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      title: "Designer",
    })}</script>`;
    const [posting] = extractJsonLdPostings(html, PAGE_URL, "Acme");
    expect(posting?.url).toBe(PAGE_URL);
  });

  it("resolves a relative posting url against the page url", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      title: "Designer",
      url: "/careers/designer",
    })}</script>`;
    const [posting] = extractJsonLdPostings(html, "https://acme.com/jobs", "Acme");
    expect(posting?.url).toBe("https://acme.com/careers/designer");
  });

  it("finds a JobPosting nested outside @graph (e.g. itemListElement)", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "ItemList",
      itemListElement: [{ "@type": "ListItem", item: { "@type": "JobPosting", title: "Analyst" } }],
    })}</script>`;
    const postings = extractJsonLdPostings(html, PAGE_URL, "Acme");
    expect(postings.map((p) => p.title)).toEqual(["Analyst"]);
  });
});

describe("extractJsonLdDescription", () => {
  it("returns the description of the first JobPosting on the page", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      title: "Engineer",
      description: "  We need TypeScript skills.  ",
    })}</script>`;
    expect(extractJsonLdDescription(html)).toBe("We need TypeScript skills.");
  });

  it("returns undefined when no JobPosting (or no description) is present", () => {
    expect(extractJsonLdDescription("<html><body>nothing</body></html>")).toBeUndefined();
    const noDesc = `<script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      title: "Engineer",
    })}</script>`;
    expect(extractJsonLdDescription(noDesc)).toBeUndefined();
  });
});

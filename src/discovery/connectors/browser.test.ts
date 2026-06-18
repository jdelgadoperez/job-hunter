import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BrowserConnector, type PageRenderer } from "./browser";

class FakeRenderer implements PageRenderer {
  constructor(private readonly html: string) {}
  async render(): Promise<string> {
    return this.html;
  }
}

async function fixtureHtml(): Promise<string> {
  const path = fileURLToPath(new URL("./__fixtures__/jobposting.html", import.meta.url));
  return readFile(path, "utf8");
}

describe("BrowserConnector", () => {
  it("extracts postings from rendered HTML", async () => {
    const connector = new BrowserConnector();
    const postings = await connector.fetchPostings(
      "https://acme.com/careers",
      "Acme",
      new FakeRenderer(await fixtureHtml()),
    );
    expect(postings).toHaveLength(1);
    expect(postings[0]?.title).toBe("Machine Learning Engineer");
  });
});

import { describe, expect, it } from "vitest";
import { FakeFetcher } from "./fetcher";

describe("FakeFetcher", () => {
  it("returns the canned response for a known url", async () => {
    const fetcher = new FakeFetcher({
      "https://example.com/a": {
        statusCode: 200,
        finalUrl: "https://example.com/a",
        bodyText: "ok",
      },
    });
    const res = await fetcher.fetch("https://example.com/a");
    expect(res.statusCode).toBe(200);
    expect(res.bodyText).toBe("ok");
  });

  it("returns a 404 for an unknown url", async () => {
    const fetcher = new FakeFetcher({});
    const res = await fetcher.fetch("https://example.com/missing");
    expect(res.statusCode).toBe(404);
  });
});

import { describe, expect, it, test, vi } from "vitest";
import { FakeFetcher, HttpFetcher } from "./fetcher";

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

function response(status: number, body: string, location?: string): Response {
  const headers = new Headers();
  if (location) headers.set("location", location);
  return { status, headers, text: async () => body } as unknown as Response;
}

describe("HttpFetcher redirect loop", () => {
  test("re-checks SSRF on every redirect hop", async () => {
    const assertAllowed = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(302, "", "https://internal.example/next"))
      .mockResolvedValueOnce(response(200, "ok"));
    const f = new HttpFetcher(1000, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      assertAllowed,
    });
    const res = await f.fetch("https://public.example/start");
    expect(res.statusCode).toBe(200);
    // guard ran for BOTH the initial URL and the redirect target
    expect(assertAllowed).toHaveBeenCalledTimes(2);
    expect(assertAllowed).toHaveBeenNthCalledWith(2, "https://internal.example/next");
  });

  test("a redirect to a blocked host is rejected by the per-hop guard", async () => {
    const assertAllowed = vi
      .fn()
      .mockResolvedValueOnce(undefined) // initial URL allowed
      .mockRejectedValueOnce(new Error("blocked: internal address")); // redirect target blocked
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(302, "", "http://169.254.169.254/"));
    const f = new HttpFetcher(1000, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      assertAllowed,
    });
    await expect(f.fetch("https://public.example/start")).rejects.toThrow(/blocked/);
  });

  test("does not follow redirects for non-GET methods", async () => {
    const assertAllowed = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(302, "", "https://elsewhere.example/"));
    const f = new HttpFetcher(1000, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      assertAllowed,
    });
    const res = await f.fetch("https://public.example/", { method: "POST", body: "x" });
    expect(res.statusCode).toBe(302); // returned as-is, not followed
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("throws after exceeding MAX_REDIRECTS", async () => {
    const assertAllowed = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => response(302, "", "https://public.example/loop"));
    const f = new HttpFetcher(1000, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      assertAllowed,
    });
    await expect(f.fetch("https://public.example/loop")).rejects.toThrow(/too many redirects/);
  });
});

import { describe, expect, it, test, vi } from "vitest";
import { FakeFetcher, type FetchImpl, HttpFetcher } from "./fetcher";
import type { AllowedUrl } from "./ssrf-guard";

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

/** An `assertAllowed` stub that approves the URL and reports no addresses (IP-literal case: nothing
 *  to pin). Redirect-loop tests only care about the guard being called, not the pinning. */
function allow(url: string): AllowedUrl {
  return { hostname: new URL(url).hostname, addresses: [] };
}

describe("HttpFetcher redirect loop", () => {
  test("re-checks SSRF on every redirect hop", async () => {
    const assertAllowed = vi.fn(async (url: string) => allow(url));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(302, "", "https://internal.example/next"))
      .mockResolvedValueOnce(response(200, "ok"));
    const f = new HttpFetcher(1000, {
      fetchImpl: fetchImpl as unknown as FetchImpl,
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
      .fn<(url: string) => Promise<AllowedUrl>>()
      .mockResolvedValueOnce(allow("https://public.example/start")) // initial URL allowed
      .mockRejectedValueOnce(new Error("blocked: internal address")); // redirect target blocked
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(302, "", "http://169.254.169.254/"));
    const f = new HttpFetcher(1000, {
      fetchImpl: fetchImpl as unknown as FetchImpl,
      assertAllowed,
    });
    await expect(f.fetch("https://public.example/start")).rejects.toThrow(/blocked/);
  });

  test("pins the connection to the validated address via a dispatcher", async () => {
    const assertAllowed = vi.fn(
      async (url: string): Promise<AllowedUrl> => ({
        hostname: new URL(url).hostname,
        addresses: [{ address: "93.184.216.34", family: 4 }],
      }),
    );
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(200, "ok"));
    const f = new HttpFetcher(1000, {
      fetchImpl: fetchImpl as unknown as FetchImpl,
      assertAllowed,
    });
    await f.fetch("https://public.example/");
    // The request carried a dispatcher pinned to the validated address (closes the DNS-rebinding
    // TOCTOU). Without pinning, the underlying fetch would re-resolve DNS independently.
    const passedInit = fetchImpl.mock.calls[0]?.[1] as { dispatcher?: unknown };
    expect(passedInit.dispatcher).toBeDefined();
  });

  test("does not pin (no dispatcher) when the host is an IP literal", async () => {
    const assertAllowed = vi.fn(async (url: string) => allow(url));
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(200, "ok"));
    const f = new HttpFetcher(1000, {
      fetchImpl: fetchImpl as unknown as FetchImpl,
      assertAllowed,
    });
    await f.fetch("https://93.184.216.34/");
    const passedInit = fetchImpl.mock.calls[0]?.[1] as { dispatcher?: unknown };
    expect(passedInit.dispatcher).toBeUndefined();
  });

  test("does not follow redirects for non-GET methods", async () => {
    const assertAllowed = vi.fn(async (url: string) => allow(url));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(302, "", "https://elsewhere.example/"));
    const f = new HttpFetcher(1000, {
      fetchImpl: fetchImpl as unknown as FetchImpl,
      assertAllowed,
    });
    const res = await f.fetch("https://public.example/", { method: "POST", body: "x" });
    expect(res.statusCode).toBe(302); // returned as-is, not followed
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("throws after exceeding MAX_REDIRECTS", async () => {
    const assertAllowed = vi.fn(async (url: string) => allow(url));
    const fetchImpl = vi.fn(async () => response(302, "", "https://public.example/loop"));
    const f = new HttpFetcher(1000, {
      fetchImpl: fetchImpl as unknown as FetchImpl,
      assertAllowed,
    });
    await expect(f.fetch("https://public.example/loop")).rejects.toThrow(/too many redirects/);
  });
});

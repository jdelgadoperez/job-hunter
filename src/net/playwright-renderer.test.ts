import { describe, expect, it, vi } from "vitest";
import {
  type InterceptedResponse,
  type InterceptedRoute,
  routeNavigation,
  screenNavigation,
} from "./playwright-renderer";
import { BlockedUrlError } from "./ssrf-guard";

describe("screenNavigation", () => {
  it("lets a non-navigation sub-resource request through without checking it", async () => {
    const assertAllowed = vi.fn(async () => {});
    const decision = await screenNavigation("https://cdn.example/app.js", false, assertAllowed);
    expect(decision).toBe("continue");
    // Sub-resources are not re-validated — no SSRF check, no per-asset DNS lookup.
    expect(assertAllowed).not.toHaveBeenCalled();
  });

  it("continues a main-frame navigation to an allowed URL", async () => {
    const assertAllowed = vi.fn(async () => {});
    const decision = await screenNavigation("https://boards.example/jobs", true, assertAllowed);
    expect(decision).toBe("continue");
    expect(assertAllowed).toHaveBeenCalledWith("https://boards.example/jobs");
  });

  it("aborts a main-frame navigation that redirects to a blocked internal address", async () => {
    const assertAllowed = vi.fn(async () => {
      throw new BlockedUrlError("host resolves to a blocked address: 169.254.169.254");
    });
    const decision = await screenNavigation(
      "http://169.254.169.254/latest/meta-data",
      true,
      assertAllowed,
    );
    expect(decision).toBe("abort");
  });

  it("rethrows a non-SSRF error rather than silently allowing the navigation", async () => {
    const assertAllowed = vi.fn(async () => {
      throw new Error("unexpected");
    });
    await expect(
      screenNavigation("https://boards.example/jobs", true, assertAllowed),
    ).rejects.toThrow("unexpected");
  });
});

describe("routeNavigation", () => {
  const allow = vi.fn(async () => "continue" as const);
  const response = (status: number, headers: Record<string, string> = {}): InterceptedResponse => ({
    status: () => status,
    headers: () => headers,
  });

  function fakeRoute(
    overrides: Partial<InterceptedRoute> & { url?: string; isNavigation?: boolean } = {},
  ) {
    const { url = "https://careers.example/jobs", isNavigation = true, ...rest } = overrides;
    return {
      request: () => ({ url: () => url, isNavigationRequest: () => isNavigation }),
      continue: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      fetch: vi.fn(async () => response(200)),
      fulfill: vi.fn(async () => {}),
      ...rest,
    };
  }

  it("passes a sub-resource request through untouched", async () => {
    const route = fakeRoute({ isNavigation: false });
    await routeNavigation(route, allow);
    expect(route.continue).toHaveBeenCalledOnce();
    expect(route.fetch).not.toHaveBeenCalled();
  });

  it("follows a redirect chain, screening each hop, and fulfills the terminal response", async () => {
    const terminal = response(200);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(302, { location: "/eng" }))
      .mockResolvedValueOnce(terminal);
    const screen = vi.fn(async () => "continue" as const);
    const route = fakeRoute({ fetch });
    await routeNavigation(route, screen);
    expect(fetch).toHaveBeenNthCalledWith(2, {
      url: "https://careers.example/eng",
      maxRedirects: 0,
    });
    expect(screen).toHaveBeenCalledWith("https://careers.example/eng", true);
    expect(route.fulfill).toHaveBeenCalledWith({ response: terminal });
  });

  it("aborts a navigation the SSRF screen refuses", async () => {
    const route = fakeRoute();
    await routeNavigation(route, async () => "abort");
    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(route.fetch).not.toHaveBeenCalled();
  });

  it("aborts after exhausting the redirect budget instead of looping", async () => {
    const route = fakeRoute({
      fetch: vi.fn(async () => response(301, { location: "https://careers.example/again" })),
    });
    await routeNavigation(route, allow);
    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(route.fulfill).not.toHaveBeenCalled();
  });

  it("aborts just the request when route.fetch dies mid-flight, instead of rejecting", async () => {
    // The 2026-07-30 scan-worker crash: an ad-tracker iframe's fetch hit "socket hang up" and the
    // handler's rejection — detached from load()'s try/catch — killed the whole scan process.
    const route = fakeRoute({
      fetch: vi.fn(async () => {
        throw new Error("route.fetch: socket hang up");
      }),
    });
    await expect(routeNavigation(route, allow)).resolves.toBeUndefined();
    expect(route.abort).toHaveBeenCalledWith("failed");
  });

  it("stays resolved even when the recovery abort itself fails (page already closed)", async () => {
    const route = fakeRoute({
      fetch: vi.fn(async () => {
        throw new Error("socket hang up");
      }),
      abort: vi.fn(async () => {
        throw new Error("Target page, context or browser has been closed");
      }),
    });
    await expect(routeNavigation(route, allow)).resolves.toBeUndefined();
  });
});

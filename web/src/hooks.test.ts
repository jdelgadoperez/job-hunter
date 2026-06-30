import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMatchAction } from "./hooks";

function mockFetch(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: status < 400,
        status,
        statusText: "OK",
        json: () => Promise.resolve(body),
      }),
    ),
  );
}

function withClient(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useMatchAction", () => {
  it("invalidates the matches query after a successful action", async () => {
    mockFetch({ ok: true });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useMatchAction(), { wrapper: withClient(client) });

    await act(async () => {
      await result.current.mutateAsync({ id: "p1", action: "saved" });
    });

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["matches"] })),
    );
  });

  it("clears the action (DELETE) when action is null", async () => {
    mockFetch({ removed: true });
    const fetchSpy = vi.mocked(fetch);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useMatchAction(), { wrapper: withClient(client) });

    await act(async () => {
      await result.current.mutateAsync({ id: "p1", action: null });
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/matches/p1/action",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("optimistically patches the cached posting's action across matches queries", async () => {
    mockFetch({ ok: true });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = [
      "matches",
      {
        minScore: 50,
        includeExpired: false,
        includeDismissed: false,
        remoteOnly: false,
        country: "",
        includeApplied: false,
        onlyApplied: false,
      },
    ];
    client.setQueryData(key, [scoredPosting("p1", null)]);

    const { result } = renderHook(() => useMatchAction(), { wrapper: withClient(client) });

    await act(async () => {
      await result.current.mutateAsync({ id: "p1", action: "saved" });
    });

    const patched = client.getQueryData<ReturnType<typeof scoredPosting>[]>(key);
    expect(patched?.[0]?.action).toBe("saved");
  });

  it("rolls the cache back to its prior value when the action request fails", async () => {
    mockFetch({ error: "boom" }, 500);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = [
      "matches",
      {
        minScore: 50,
        includeExpired: false,
        includeDismissed: false,
        remoteOnly: false,
        country: "",
        includeApplied: false,
        onlyApplied: false,
      },
    ];
    client.setQueryData(key, [scoredPosting("p1", null)]);

    const { result } = renderHook(() => useMatchAction(), { wrapper: withClient(client) });

    await act(async () => {
      await result.current.mutateAsync({ id: "p1", action: "saved" }).catch(() => {});
    });

    const rolledBack = client.getQueryData<ReturnType<typeof scoredPosting>[]>(key);
    expect(rolledBack?.[0]?.action).toBeNull();
  });
});

function scoredPosting(id: string, action: "saved" | "dismissed" | "applied" | null) {
  return {
    posting: {
      id,
      company: "Acme",
      title: "Engineer",
      url: `https://acme.com/jobs/${id}`,
      source: "greenhouse",
      description: "",
      fetchedAt: "2026-06-30T00:00:00.000Z",
    },
    result: { score: 80, matchedSkills: [], missingSkills: [] },
    action,
    expired: false,
  };
}

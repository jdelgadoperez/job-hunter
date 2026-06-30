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
});

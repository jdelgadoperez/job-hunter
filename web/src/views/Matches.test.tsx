import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Matches } from "./Matches";

function mockMatches(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(body),
      }),
    ),
  );
}

function renderMatches() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return render(<Matches />, { wrapper });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Matches empty state", () => {
  it("tells the user to loosen filters when the default score floor hides everything", async () => {
    // Default mount has minScore=50, which counts as an active filter.
    mockMatches([]);
    renderMatches();

    await waitFor(() =>
      expect(
        screen.getByText(/lowering the minimum score or clearing filters/i),
      ).toBeInTheDocument(),
    );
  });

  it("tells the user to run a scan when no filters are narrowing the result", async () => {
    mockMatches([]);
    renderMatches();

    // Drop the score floor to 0 so no filter is active; the copy should switch to the scan hint.
    const slider = await screen.findByLabelText(/minimum score/i);
    fireEvent.change(slider, { target: { value: "0" } });

    await waitFor(() =>
      expect(screen.getByText(/Run a scan from the Home tab/i)).toBeInTheDocument(),
    );
  });
});

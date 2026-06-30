import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// App mounts every view at once, so respond to any endpoint with a benign empty shape.
function mockAllEndpoints() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const body =
        url.includes("/api/version") || url.includes("/api/settings") || url.includes("/api/scan")
          ? versionOrSettingsOrScan(url)
          : url.includes("/api/profile") || url.includes("/api/scans/latest")
            ? null
            : [];
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(body),
      });
    }),
  );
}

function versionOrSettingsOrScan(url: string) {
  if (url.includes("/api/version"))
    return { version: "1.0.0", behind: null, updateAvailable: false };
  if (url.includes("/api/settings"))
    return {
      hasAnthropicKey: false,
      scorerModel: null,
      scorerProvider: null,
      hasTheMuseKey: false,
      feedUrl: null,
      hasFeedKey: false,
    };
  return {
    state: "idle",
    message: null,
    current: null,
    total: null,
    count: null,
    warnings: [],
    error: null,
    startedAt: null,
    finishedAt: null,
    recent: [],
  };
}

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return render(<App />, { wrapper });
}

beforeEach(() => {
  window.location.hash = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App tab navigation", () => {
  it("keeps Matches filter state when switching tabs and back", async () => {
    mockAllEndpoints();
    renderApp();

    await userEvent.click(screen.getByRole("button", { name: "Matches" }));
    const slider = await screen.findByLabelText(/minimum score/i);
    await waitFor(() => expect(slider).toBeVisible());

    // Change the filter, leave, and return.
    fireEvent.change(slider, { target: { value: "75" } });
    expect(screen.getByText(/Minimum score:/i)).toHaveTextContent("75");

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Matches" }));

    // Because the tab stays mounted, the filter survives the round-trip.
    expect(screen.getByText(/Minimum score:/i)).toHaveTextContent("75");
  });
});

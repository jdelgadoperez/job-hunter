import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Home } from "./Home";

type Bodies = {
  settings?: { hasAnthropicKey: boolean };
  scanState?: string;
  scoreState?: string;
  preview?: unknown;
};

function idleScan(state = "idle") {
  return {
    state,
    message: null,
    current: null,
    total: null,
    count: null,
    warnings: [],
    error: null,
    startedAt: state === "running" ? "2026-06-30T00:00:00.000Z" : null,
    finishedAt: null,
    recent: [],
  };
}

function idleScore(state = "idle") {
  return {
    state,
    message: null,
    counts: null,
    estimate: null,
    abortedOnLimit: false,
    warnings: [],
    error: null,
    startedAt: null,
    finishedAt: null,
  };
}

function mockFetch(bodies: Bodies) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const body = (() => {
        if (url.includes("/api/settings")) {
          return {
            hasAnthropicKey: bodies.settings?.hasAnthropicKey ?? false,
            scorerModel: null,
            scorerProvider: null,
            homeCountry: null,
            hasTheMuseKey: false,
            feedUrl: null,
            hasFeedKey: false,
          };
        }
        if (url.includes("/api/score/preview")) return bodies.preview;
        if (url.includes("/api/score/status")) return idleScore(bodies.scoreState);
        if (url.includes("/api/score") && init?.method === "POST") return idleScore("running");
        if (url.includes("/api/scan")) return idleScan(bodies.scanState);
        if (url.includes("/api/profile") || url.includes("/api/scans/latest")) return null;
        if (url.includes("/api/version"))
          return { version: "1.0.0", behind: null, updateAvailable: false };
        return [];
      })();
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(body),
      });
    }),
  );
}

function renderHome() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return render(<Home />, { wrapper });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Home deep-score card", () => {
  it("prompts to add a key when none is configured", async () => {
    mockFetch({ settings: { hasAnthropicKey: false } });
    renderHome();
    await waitFor(() =>
      expect(screen.getByText(/Add an Anthropic API key in Settings/i)).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Deep-score" })).not.toBeInTheDocument();
  });

  it("shows the cost estimate after a preview", async () => {
    mockFetch({
      settings: { hasAnthropicKey: true },
      preview: {
        counts: {
          inDb: 50,
          afterRemote: 30,
          afterHeuristic: 40,
          afterCap: 30,
          alreadyScoredSkipped: 0,
          triageTitles: 30,
          deepScored: 0,
          remotePenalized: 0,
        },
        estimate: {
          triageTitles: 30,
          triageBatches: 1,
          deepScores: 30,
          triageUsd: 0.01,
          deepScoreUsd: 0.29,
          totalUsd: 0.3,
        },
      },
    });
    renderHome();

    await userEvent.click(await screen.findByRole("button", { name: "Preview" }));

    await waitFor(() => expect(screen.getByText(/est\./i)).toHaveTextContent("$0.30"));
    expect(screen.getByText(/30 posting\(s\) to score/i)).toBeInTheDocument();
  });

  it("disables deep-score while a scan is running (mutual exclusion)", async () => {
    mockFetch({ settings: { hasAnthropicKey: true }, scanState: "running" });
    renderHome();

    const button = await screen.findByRole("button", { name: "Deep-score" });
    await waitFor(() => expect(button).toBeDisabled());
    expect(screen.getByText(/Waiting for the scan to finish/i)).toBeInTheDocument();
  });
});

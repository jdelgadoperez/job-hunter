import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Companies } from "./Companies";

type Bodies = {
  companies?: { careersUrl: string; name?: string }[];
  manualReview?: { careersUrl: string; name?: string }[];
  needsAttention?: {
    careersUrl: string;
    company: string;
    message: string;
    consecutiveFailures: number;
  }[];
};

function mockFetch(bodies: Bodies) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const body = (() => {
        if (url.includes("/api/companies/needs-attention")) return bodies.needsAttention ?? [];
        if (url.includes("/api/companies/manual-review")) return bodies.manualReview ?? [];
        if (url.includes("/api/scan/retry-failed") && init?.method === "POST") {
          return {
            state: "running",
            message: null,
            current: null,
            total: null,
            count: null,
            warnings: [],
            error: null,
            startedAt: "2026-07-01T00:00:00.000Z",
            finishedAt: null,
            recent: [],
          };
        }
        if (url.includes("/api/companies")) return bodies.companies ?? [];
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

/** Route requests dynamically via a callback, for tests where the response changes over time
 *  (e.g. scan-status polling transitioning from "running" to "done"). */
function mockFetchWith(router: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const body = router(url, init);
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(body),
      });
    }),
  );
}

function renderCompanies() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return render(<Companies />, { wrapper });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Companies needs-attention panel", () => {
  it("does not render the panel when the needs-attention list is empty", async () => {
    mockFetch({ needsAttention: [] });
    renderCompanies();
    await waitFor(() => expect(screen.queryByText(/Needs attention/i)).not.toBeInTheDocument());
  });

  it("renders each company with its message and failure count", async () => {
    mockFetch({
      needsAttention: [
        {
          careersUrl: "https://boom.com/careers",
          company: "Boom",
          message: "render crashed",
          consecutiveFailures: 5,
        },
      ],
    });
    renderCompanies();

    await waitFor(() => expect(screen.getByText(/Needs attention \(1\)/i)).toBeInTheDocument());
    expect(screen.getByText("Boom")).toBeInTheDocument();
    expect(screen.getByText(/render crashed/)).toBeInTheDocument();
    expect(screen.getByText(/5 scans/)).toBeInTheDocument();
  });

  it("triggers a rescan when the Rescan button is clicked", async () => {
    mockFetch({
      needsAttention: [
        {
          careersUrl: "https://boom.com/careers",
          company: "Boom",
          message: "render crashed",
          consecutiveFailures: 5,
        },
      ],
    });
    renderCompanies();

    const button = await screen.findByRole("button", { name: "Rescan" });
    await userEvent.click(button);

    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(
            (call) =>
              String(call[0]).includes("/api/scan/retry-failed") && call[1]?.method === "POST",
          ),
      ).toBe(true),
    );
  });

  it("refreshes the needs-attention panel after a scan completes", async () => {
    const recovered = {
      careersUrl: "https://boom.com/careers",
      company: "Boom",
      message: "render crashed",
      consecutiveFailures: 5,
    };
    let needsAttentionBody: unknown[] = [recovered];
    let scanState = "running";

    mockFetchWith((url) => {
      if (url.includes("/api/companies/needs-attention")) return needsAttentionBody;
      if (url.includes("/api/companies/manual-review")) return [];
      if (url.includes("/api/scan/status")) {
        return {
          state: scanState,
          message: null,
          current: null,
          total: null,
          count: null,
          warnings: [],
          error: null,
          startedAt: "2026-07-01T00:00:00.000Z",
          finishedAt: scanState === "done" ? "2026-07-01T00:05:00.000Z" : null,
          recent: [],
        };
      }
      if (url.includes("/api/companies")) return [];
      return [];
    });

    renderCompanies();

    await waitFor(() => expect(screen.getByText(/Needs attention \(1\)/i)).toBeInTheDocument());

    // The scan completes in the background (the Rescan button's retry scan); the company recovers
    // and is cleared from failed_leads server-side. useScanStatus polls every 1s (real timers) until
    // it observes the "done" transition, which should invalidate the needs-attention query.
    needsAttentionBody = [];
    scanState = "done";

    await waitFor(() => expect(screen.queryByText(/Needs attention/i)).not.toBeInTheDocument(), {
      timeout: 5000,
    });
  });
});

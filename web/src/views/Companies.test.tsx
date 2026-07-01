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
});

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

type PostingSeed = { id: string; title: string; company: string };

function scored({ id, title, company }: PostingSeed) {
  return {
    posting: {
      id,
      company,
      title,
      url: `https://example.com/${id}`,
      source: "greenhouse",
      description: "",
      remote: true,
      fetchedAt: new Date("2026-06-17T00:00:00Z").toISOString(),
    },
    result: { score: 90, matchedSkills: [], missingSkills: [] },
    action: null,
    expired: false,
  };
}

// Mock that honors the `search` query param so we can assert the search box drives the request.
function mockSearchableMatches(all: PostingSeed[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const search = new URL(url, "http://localhost").searchParams.get("search");
      const matched = search
        ? all.filter((p) => `${p.title} ${p.company}`.toLowerCase().includes(search.toLowerCase()))
        : all;
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(matched.map(scored)),
      });
    }),
  );
}

describe("Matches search filter", () => {
  const seeds: PostingSeed[] = [
    { id: "a", title: "Staff Platform Engineer", company: "Acme" },
    { id: "b", title: "Frontend Engineer", company: "Globex" },
  ];

  it("narrows the list to matches for the committed search term on Enter", async () => {
    mockSearchableMatches(seeds);
    renderMatches();

    expect(await screen.findByText(/Staff Platform Engineer/)).toBeInTheDocument();
    expect(screen.getByText(/Frontend Engineer/)).toBeInTheDocument();

    const box = screen.getByLabelText(/search matches/i);
    fireEvent.change(box, { target: { value: "Globex" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(screen.getByText(/Frontend Engineer/)).toBeInTheDocument());
    expect(screen.queryByText(/Staff Platform Engineer/)).not.toBeInTheDocument();
  });

  it("restores the full list when the search term is cleared", async () => {
    mockSearchableMatches(seeds);
    renderMatches();

    const box = await screen.findByLabelText(/search matches/i);
    fireEvent.change(box, { target: { value: "Globex" } });
    fireEvent.blur(box);
    await waitFor(() =>
      expect(screen.queryByText(/Staff Platform Engineer/)).not.toBeInTheDocument(),
    );

    fireEvent.change(box, { target: { value: "" } });
    fireEvent.blur(box);
    await waitFor(() => expect(screen.getByText(/Staff Platform Engineer/)).toBeInTheDocument());
  });
});

describe("Matches company links", () => {
  it("renders website, Glassdoor, LinkedIn and Crunchbase links on each card, in a new tab", async () => {
    mockMatches([scored({ id: "a", title: "Engineer", company: "acme-corp" })]);
    renderMatches();

    const website = await screen.findByRole("link", { name: /website — search for acme-corp/i });
    expect(website).toHaveAttribute("target", "_blank");
    expect(website).toHaveAttribute("rel", "noreferrer");

    for (const label of [/glassdoor/i, /linkedin/i, /crunchbase/i]) {
      const link = screen.getByRole("link", { name: label });
      expect(link).toHaveAttribute("target", "_blank");
      expect(link.getAttribute("href")).toMatch(/^https:\/\//);
    }
  });
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

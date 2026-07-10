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

type PostingSeed = { id: string; title: string; company: string; country?: string };

function scored({ id, title, company, country }: PostingSeed) {
  return {
    posting: {
      id,
      company,
      title,
      url: `https://example.com/${id}`,
      source: "greenhouse",
      description: "",
      remote: true,
      ...(country ? { country } : {}),
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

// Mock that mirrors the server's country filter (keep an exact match OR an unknown-country
// posting), so we can assert the aggregate count reflects what the server actually returns.
function mockCountryFilterableMatches(all: PostingSeed[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const country = new URL(url, "http://localhost").searchParams.get("country");
      const matched = country
        ? all.filter((p) => p.country === country || p.country === undefined)
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

// Mock that also answers PUT/DELETE on /api/matches/:id/action, tracking each posting's action
// server-side so a GET fired by useMatchAction's onSettled refetch reflects it. Without this, the
// refetch that follows every mutation would overwrite the optimistic cache patch back to whatever
// `scored()`'s hardcoded `action: null` says, masking any real button-state bug.
function mockMatchesWithActions(seeds: PostingSeed[]) {
  const actions = new Map<string, "saved" | "dismissed" | "applied" | null>();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const match = String(url).match(/\/api\/matches\/([^/]+)\/action/);
      const rawId = match?.[1];
      if (rawId !== undefined) {
        const id = decodeURIComponent(rawId);
        if (init?.method === "DELETE") {
          actions.set(id, null);
          return Promise.resolve({
            ok: true,
            status: 200,
            statusText: "OK",
            json: () => Promise.resolve({ removed: true }),
          });
        }
        const { action } = JSON.parse(String(init?.body));
        actions.set(id, action);
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => Promise.resolve({ ok: true }),
        });
      }
      const body = seeds.map((seed) => ({
        ...scored(seed),
        action: actions.get(seed.id) ?? null,
      }));
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(body),
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

    // The label uses the normalized display name ("Acme Corp"), not the raw slug ("acme-corp").
    const website = await screen.findByRole("link", { name: /website — search for Acme Corp/i });
    expect(website).toHaveAttribute("target", "_blank");
    expect(website).toHaveAttribute("rel", "noreferrer");

    for (const label of [/glassdoor/i, /linkedin/i, /crunchbase/i]) {
      const link = screen.getByRole("link", { name: label });
      expect(link).toHaveAttribute("target", "_blank");
      expect(link.getAttribute("href")).toMatch(/^https:\/\//);
    }
  });

  it("marks the decorative icons as aria-hidden so only the link label is announced", async () => {
    mockMatches([scored({ id: "a", title: "Engineer", company: "acme-corp" })]);
    renderMatches();

    const website = await screen.findByRole("link", { name: /website — search for Acme Corp/i });
    expect(website.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
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

describe("Matches pagination", () => {
  function manySeeds(count: number): PostingSeed[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `p${i}`,
      title: `Posting Number ${i}`,
      company: "Acme",
    }));
  }

  it("renders only the first page and offers Show more for a large result set", async () => {
    mockMatches(manySeeds(120).map(scored));
    renderMatches();

    await screen.findByText(/Posting Number 0/);
    expect(screen.queryByText(/Posting Number 49/)).toBeInTheDocument();
    expect(screen.queryByText(/Posting Number 50/)).not.toBeInTheDocument();

    expect(screen.getByText(/Showing/)).toHaveTextContent("Showing 50 of 120 matches");
    expect(screen.getByRole("button", { name: /show more \(70 remaining\)/i })).toBeInTheDocument();
  });

  it("reveals another page per click and removes the button once everything is shown", async () => {
    mockMatches(manySeeds(120).map(scored));
    renderMatches();

    await screen.findByText(/Posting Number 0/);
    fireEvent.click(screen.getByRole("button", { name: /show more/i }));

    await waitFor(() => expect(screen.getByText(/Posting Number 99/)).toBeInTheDocument());
    expect(screen.queryByText(/Posting Number 100/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /show more/i }));

    await waitFor(() => expect(screen.getByText(/Posting Number 119/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /show more/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Showing/)).toHaveTextContent(
      "Showing 120 matches at the current filters",
    );
  });

  it("does not show a Show more button when the result set fits in one page", async () => {
    mockMatches(manySeeds(10).map(scored));
    renderMatches();

    await screen.findByText(/Posting Number 0/);
    expect(screen.queryByRole("button", { name: /show more/i })).not.toBeInTheDocument();
  });

  it("resets back to the first page when a filter changes the query", async () => {
    mockSearchableMatches(manySeeds(120));
    renderMatches();

    await screen.findByText(/Posting Number 0/);
    fireEvent.click(screen.getByRole("button", { name: /show more/i }));
    await waitFor(() => expect(screen.getByText(/Posting Number 99/)).toBeInTheDocument());

    const remoteOnly = screen.getByLabelText(/remote only/i);
    fireEvent.click(remoteOnly);

    await waitFor(() =>
      expect(screen.getByText(/Showing/)).toHaveTextContent("Showing 50 of 120 matches"),
    );
    expect(screen.queryByText(/Posting Number 99/)).not.toBeInTheDocument();
  });
});

describe("Matches clear filters", () => {
  it("hides the clear-filters control when no filter is active", async () => {
    mockMatches([scored({ id: "a", title: "Staff Platform Engineer", company: "Acme" })]);
    renderMatches();

    await screen.findByText(/Staff Platform Engineer/);
    // Default mount has minScore=50, which counts as active, so drop it to 0 first.
    const slider = screen.getByLabelText(/minimum score/i);
    fireEvent.change(slider, { target: { value: "0" } });

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /clear filters/i })).not.toBeInTheDocument(),
    );
  });

  it("resets search, score, and remote-only back to defaults in one click", async () => {
    mockSearchableMatches([
      { id: "a", title: "Staff Platform Engineer", company: "Acme" },
      { id: "b", title: "Frontend Engineer", company: "Globex" },
    ]);
    renderMatches();

    await screen.findByText(/Staff Platform Engineer/);

    const box = screen.getByLabelText(/search matches/i);
    fireEvent.change(box, { target: { value: "Globex" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(screen.queryByText(/Staff Platform Engineer/)).not.toBeInTheDocument(),
    );

    const remoteOnly = screen.getByLabelText(/remote only/i);
    fireEvent.click(remoteOnly);

    const clearButton = await screen.findByRole("button", { name: /clear filters/i });
    fireEvent.click(clearButton);

    await waitFor(() => expect(screen.getByText(/Staff Platform Engineer/)).toBeInTheDocument());
    expect(screen.getByText(/Frontend Engineer/)).toBeInTheDocument();
    expect(box).toHaveValue("");
    expect(remoteOnly).not.toBeChecked();
    // minScore reverts to its default (SCORE_THRESHOLDS.relevant), which still counts as an
    // active filter by design, so the button itself remains visible after a clear.
    expect(screen.getByRole("button", { name: /clear filters/i })).toBeInTheDocument();
  });
});

describe("Matches applied overwrites saved", () => {
  it("marks applied immediately when the posting isn't saved", async () => {
    mockMatchesWithActions([{ id: "a", title: "Staff Platform Engineer", company: "Acme" }]);
    renderMatches();

    const markApplied = await screen.findByRole("button", { name: "Mark applied" });
    fireEvent.click(markApplied);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /✓ Applied/i })).toBeInTheDocument(),
    );
    expect(screen.queryByText(/this will replace saved/i)).not.toBeInTheDocument();
  });

  it("arms a confirm step instead of applying immediately when the posting is saved", async () => {
    mockMatchesWithActions([{ id: "a", title: "Staff Platform Engineer", company: "Acme" }]);
    renderMatches();

    fireEvent.click(await screen.findByRole("button", { name: "☆ Save" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /★ Saved/i })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Mark applied" }));

    expect(screen.getByText(/this will replace saved/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /✓ Applied/i })).not.toBeInTheDocument();
    // The saved state is untouched until the user actually confirms.
    expect(screen.getByRole("button", { name: /★ Saved/i })).toBeInTheDocument();
  });

  it("applies and drops the saved state once the overwrite is confirmed", async () => {
    mockMatchesWithActions([{ id: "a", title: "Staff Platform Engineer", company: "Acme" }]);
    renderMatches();

    fireEvent.click(await screen.findByRole("button", { name: "☆ Save" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /★ Saved/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark applied" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /✓ Applied/i })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "☆ Save" })).toBeInTheDocument();
  });

  it("backs out without applying when the confirm step is cancelled", async () => {
    mockMatchesWithActions([{ id: "a", title: "Staff Platform Engineer", company: "Acme" }]);
    renderMatches();

    fireEvent.click(await screen.findByRole("button", { name: "☆ Save" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /★ Saved/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark applied" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: /★ Saved/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark applied" })).toBeInTheDocument();
    expect(screen.queryByText(/this will replace saved/i)).not.toBeInTheDocument();
  });
});

describe("Matches expired postings", () => {
  it("carries a non-color signal (accessible label) beyond the dimming class", async () => {
    mockMatches([{ ...scored({ id: "a", title: "Stale Role", company: "Acme" }), expired: true }]);
    renderMatches();

    await screen.findByText(/Stale Role/);

    // The badge must expose an accessible name announcing expiry, not just visible dimmed text.
    const badge = screen.getByRole("note", { name: /this role has expired/i });
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent(/expired/i);
  });
});

describe("Matches count header", () => {
  const solo: PostingSeed = { id: "a", title: "Staff Platform Engineer", company: "Acme" };
  const seeds: PostingSeed[] = [solo, { id: "b", title: "Frontend Engineer", company: "Globex" }];

  it("shows the number of matches in the current view", async () => {
    mockMatches(seeds.map(scored));
    renderMatches();

    // Default mount keeps minScore=50, so the count is filter-scoped.
    await waitFor(() =>
      expect(screen.getByText(/Showing/)).toHaveTextContent(
        `Showing ${seeds.length} matches at the current filters`,
      ),
    );
  });

  it("uses the singular noun for a single match", async () => {
    mockMatches([scored(solo)]);
    renderMatches();

    await waitFor(() => expect(screen.getByText(/Showing/)).toHaveTextContent(/1 match\b/));
    expect(screen.queryByText(/1 matches/)).not.toBeInTheDocument();
  });

  it("omits the count header when there are no matches", async () => {
    mockMatches([]);
    renderMatches();

    await waitFor(() => expect(screen.getByText(/clearing filters/i)).toBeInTheDocument());
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
  });
});

describe("Matches country filter count", () => {
  // Selecting "Germany" also returns unknown-country postings (the server never silently drops
  // them, per repository.ts), so the aggregate count should call that split out.
  const withCountry: PostingSeed = {
    id: "a",
    title: "Berlin Engineer",
    company: "Acme",
    country: "Germany",
  };
  const unknownCountry: PostingSeed = { id: "b", title: "Remote Engineer", company: "Globex" };

  it("appends an unknown-location count once a country filter is applied", async () => {
    mockCountryFilterableMatches([withCountry, unknownCountry]);
    renderMatches();

    // The dropdown only lists countries already seen, so this shows up once the unfiltered
    // query returns "Germany" from the seed above.
    const select = await screen.findByLabelText(/country/i);
    fireEvent.change(select, { target: { value: "Germany" } });

    await waitFor(() =>
      expect(screen.getByText(/Showing/)).toHaveTextContent(
        "Showing 2 matches at the current filters (1 with unknown location)",
      ),
    );
  });

  it("omits the unknown-location count when no country filter is applied", async () => {
    mockCountryFilterableMatches([withCountry, unknownCountry]);
    renderMatches();

    await waitFor(() =>
      expect(screen.getByText(/Showing/)).toHaveTextContent(
        "Showing 2 matches at the current filters",
      ),
    );
    expect(screen.queryByText(/unknown location/i)).not.toBeInTheDocument();
  });

  it("omits the unknown-location count when every result has a confirmed country", async () => {
    mockCountryFilterableMatches([withCountry]);
    renderMatches();

    const select = await screen.findByLabelText(/country/i);
    fireEvent.change(select, { target: { value: "Germany" } });

    await waitFor(() =>
      expect(screen.getByText(/Showing/)).toHaveTextContent(
        "Showing 1 match at the current filters",
      ),
    );
    expect(screen.queryByText(/unknown location/i)).not.toBeInTheDocument();
  });
});

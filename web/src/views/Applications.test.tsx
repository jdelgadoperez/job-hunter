import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Application } from "../api";
import { Applications } from "./Applications";

function app(overrides: Partial<Application> = {}): Application {
  return {
    id: 1,
    company: "Acme",
    role: "Staff Engineer",
    status: "applied",
    dateApplied: "2026-11-01",
    url: "https://acme.example/jobs/1",
    source: "greenhouse",
    salaryRange: "200k",
    recruiter: "Kim",
    postingId: null,
    archived: false,
    createdAt: "2026-11-01 00:00:00",
    updatedAt: "2026-11-01 00:00:00",
    notes: [{ id: 1, applicationId: 1, date: "2026-11-01", content: "Applied" }],
    ...overrides,
  };
}

type Call = { url: string; method: string; body: unknown };

/** Route fetches through `router`; records every call so tests can assert on writes. */
function mockFetch(router: (url: string, method: string) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const body = router(url, method);
      const error = typeof body === "object" && body !== null && "error" in body;
      return Promise.resolve({
        ok: !error,
        status: error ? 400 : 200,
        statusText: error ? "Bad Request" : "OK",
        json: () => Promise.resolve(body),
      });
    }),
  );
  return calls;
}

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client: qc }, createElement(Applications)));
}

const STATS = { active: { applied: 1, interviewed: 1 }, archived: { rejected: 2 } };

afterEach(() => vi.unstubAllGlobals());

describe("Applications view", () => {
  it("lists applications with status filters from the stats", async () => {
    const calls = mockFetch((url) => {
      if (url.includes("/stats")) return STATS;
      if (url.includes("status=interviewed")) {
        return [app({ id: 2, company: "Globex", status: "interviewed" })];
      }
      return [app(), app({ id: 2, company: "Globex", status: "interviewed" })];
    });
    renderView();
    expect(await screen.findByText("Acme — Staff Engineer")).toBeInTheDocument();
    expect(screen.getByText("Globex — Staff Engineer")).toBeInTheDocument();

    await userEvent.click(await screen.findByRole("button", { name: "Interviewed · 1" }));
    await waitFor(() => expect(screen.queryByText("Acme — Staff Engineer")).toBeNull());
    expect(calls.some((c) => c.url === "/api/applications?status=interviewed")).toBe(true);
  });

  it("shows an empty state", async () => {
    mockFetch((url) => (url.includes("/stats") ? { active: {}, archived: {} } : []));
    renderView();
    expect(await screen.findByText(/No applications yet/)).toBeInTheDocument();
  });

  it("searches and toggles archived", async () => {
    const calls = mockFetch((url) => (url.includes("/stats") ? STATS : []));
    renderView();
    await userEvent.type(screen.getByLabelText("Search applications"), "kim");
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/api/applications?search=kim")).toBe(true),
    );
    expect(await screen.findByText("No applications match.")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Search applications"));
    await userEvent.click(screen.getByRole("button", { name: "Archived" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/api/applications?archived=true")).toBe(true),
    );
  });

  it("changes status through the select", async () => {
    const calls = mockFetch((url, method) => {
      if (url.includes("/stats")) return STATS;
      if (method === "PATCH") return app({ status: "screened" });
      return [app()];
    });
    renderView();
    await userEvent.selectOptions(await screen.findByLabelText("Status for Acme"), "screened");
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")).toEqual({
        url: "/api/applications/1",
        method: "PATCH",
        body: { status: "screened" },
      }),
    );
  });

  it("expands to show details and notes, adds a note, and deletes with confirmation", async () => {
    const calls = mockFetch((url, method) => {
      if (url.includes("/stats")) return STATS;
      if (method === "POST" && url.endsWith("/notes")) return app();
      if (method === "DELETE") return { removed: true };
      return [app()];
    });
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Acme — Staff Engineer" }));
    const notes = screen.getByRole("list", { name: "Notes" });
    expect(within(notes).getByText("Applied")).toBeInTheDocument();
    expect(screen.getByText("200k")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive" })).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Note for Acme"), "Recruiter call");
    await userEvent.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith("/notes"))?.body).toEqual({
        content: "Recruiter call",
      }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });

  it("archives closed applications and unarchives archived ones", async () => {
    const calls = mockFetch((url, method) => {
      if (url.includes("/stats")) return STATS;
      if (method === "POST") return app({ status: "rejected" });
      if (url.includes("archived=true")) {
        return [app({ id: 3, company: "Initech", status: "ghosted", archived: true })];
      }
      return [app({ status: "rejected" })];
    });
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Acme — Staff Engineer" }));
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/api/applications/1/archive")).toBe(true),
    );

    await userEvent.click(screen.getByRole("button", { name: "Archived" }));
    await userEvent.click(await screen.findByRole("button", { name: "Initech — Staff Engineer" }));
    await userEvent.click(screen.getByRole("button", { name: "Unarchive" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/api/applications/3/unarchive")).toBe(true),
    );
  });

  it("adds an application from the form and surfaces server errors", async () => {
    let fail = true;
    const calls = mockFetch((url, method) => {
      if (url.includes("/stats")) return STATS;
      if (method === "POST") {
        if (fail) {
          fail = false;
          return { error: "invalid date" };
        }
        return app();
      }
      return [];
    });
    renderView();
    await userEvent.click(screen.getByRole("button", { name: "Add application" }));
    await userEvent.type(screen.getByLabelText("Company"), "Acme");
    await userEvent.type(screen.getByLabelText("Role"), "Staff Engineer");
    await userEvent.type(screen.getByLabelText("Posting URL"), "https://acme.example");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText(/invalid date/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByLabelText("Company")).toBeNull());
    expect(calls.filter((c) => c.method === "POST").at(-1)?.body).toEqual({
      company: "Acme",
      role: "Staff Engineer",
      url: "https://acme.example",
    });
  });

  it("can cancel the add form", async () => {
    mockFetch((url) => (url.includes("/stats") ? STATS : []));
    renderView();
    await userEvent.click(screen.getByRole("button", { name: "Add application" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Company")).toBeNull();
  });
});

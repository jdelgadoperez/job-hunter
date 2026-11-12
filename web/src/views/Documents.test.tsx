import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentMeta, Note } from "../api";
import { Documents } from "./Documents";

const NOTE: Note = {
  id: 1,
  applicationId: 7,
  name: "prep.md",
  kind: "note",
  mime: "text/markdown; charset=utf-8",
  size: 120,
  createdAt: "2026-11-11 00:00:00",
  updatedAt: "2026-11-11 00:00:00",
  content:
    "# Solace prep\n\n| Round | Who |\n| --- | --- |\n| 1 | Recruiter |\n\n<script>alert(1)</script>\n\n[site](https://solace.example)",
};
const FILE: DocumentMeta = {
  id: 2,
  applicationId: 7,
  name: "resume/r.pdf",
  kind: "file",
  mime: "application/pdf",
  size: 2048,
  createdAt: "2026-11-11 00:00:00",
  updatedAt: "2026-11-11 00:00:00",
};

type Call = { url: string; method: string; body: unknown };

function mockFetch(router: (url: string, method: string, body: unknown) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      const data = router(url, method, body);
      const error = typeof data === "object" && data !== null && "error" in data;
      return Promise.resolve({
        ok: !error,
        status: error ? 400 : 200,
        statusText: error ? "Bad Request" : "OK",
        json: () => Promise.resolve(data),
      });
    }),
  );
  return calls;
}

function renderDocs() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(Documents, { applicationId: 7 }),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("Documents", () => {
  it("lists notes and files; files link to their raw URL", async () => {
    mockFetch(() => [NOTE, FILE]);
    renderDocs();
    const list = await screen.findByRole("list", { name: "Documents" });
    expect(within(list).getByRole("button", { name: "prep.md" })).toBeInTheDocument();
    const link = within(list).getByRole("link", { name: "resume/r.pdf" });
    expect(link).toHaveAttribute("href", "/api/applications/7/documents/2/raw");
    expect(link).toHaveAttribute("target", "_blank");
    expect(within(list).getByText("file · 2.0 KB")).toBeInTheDocument();
    expect(within(list).getByText("note · 120 B")).toBeInTheDocument();
  });

  it("shows an empty state", async () => {
    mockFetch(() => []);
    renderDocs();
    expect(await screen.findByText(/No documents/)).toBeInTheDocument();
  });

  it("renders a note as markdown (tables, safe links, no raw HTML) and closes it", async () => {
    mockFetch((url) => (url.endsWith("/documents") ? [NOTE, FILE] : NOTE));
    renderDocs();
    await userEvent.click(await screen.findByRole("button", { name: "prep.md" }));
    const view = await screen.findByRole("region", { name: "prep.md" });
    expect(await within(view).findByRole("heading", { name: "Solace prep" })).toBeInTheDocument();
    expect(within(view).getByRole("table")).toBeInTheDocument();
    expect(within(view).getByRole("link", { name: "site" })).toHaveAttribute("target", "_blank");
    expect(view.querySelector("script")).toBeNull();

    await userEvent.click(within(view).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("region", { name: "prep.md" })).toBeNull();
  });

  it("edits and saves a note", async () => {
    const calls = mockFetch((url, method, body) => {
      if (method === "PUT") return { ...NOTE, content: (body as { content: string }).content };
      return url.endsWith("/documents") ? [NOTE] : NOTE;
    });
    renderDocs();
    await userEvent.click(await screen.findByRole("button", { name: "prep.md" }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = screen.getByLabelText("Edit prep.md");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.clear(editor);
    await userEvent.type(editor, "# New");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")).toEqual({
        url: "/api/applications/7/documents/1",
        method: "PUT",
        body: { content: "# New" },
      }),
    );
    await waitFor(() => expect(screen.queryByLabelText("Edit prep.md")).toBeNull());
  });

  it("cancels an edit without saving", async () => {
    const calls = mockFetch((url) => (url.endsWith("/documents") ? [NOTE] : NOTE));
    renderDocs();
    await userEvent.click(await screen.findByRole("button", { name: "prep.md" }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Edit prep.md")).toBeNull();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("deletes a note after confirmation", async () => {
    const calls = mockFetch((url, method) => {
      if (method === "DELETE") return { removed: true };
      return url.endsWith("/documents") ? [NOTE] : NOTE;
    });
    renderDocs();
    await userEvent.click(await screen.findByRole("button", { name: "prep.md" }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "DELETE")?.url).toBe("/api/applications/7/documents/1"),
    );
    await waitFor(() => expect(screen.queryByRole("region", { name: "prep.md" })).toBeNull());
  });

  it("creates a note, adding .md and a title, then opens it", async () => {
    const created: Note = { ...NOTE, id: 9, name: "onsite.md", content: "# onsite\n" };
    const calls = mockFetch((url, method) => {
      if (method === "POST") return created;
      if (url.endsWith("/documents/9")) return created;
      return url.endsWith("/documents") ? [created] : NOTE;
    });
    renderDocs();
    await userEvent.click(await screen.findByRole("button", { name: "New note" }));
    await userEvent.type(screen.getByLabelText("New note name"), "onsite");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        name: "onsite.md",
        content: "# onsite\n",
      }),
    );
    expect(await screen.findByRole("region", { name: "onsite.md" })).toBeInTheDocument();
  });

  it("can cancel creating a note and surfaces errors", async () => {
    mockFetch((_url, method) => (method === "POST" ? { error: "invalid document name" } : []));
    renderDocs();
    await userEvent.click(await screen.findByRole("button", { name: "New note" }));
    await userEvent.type(screen.getByLabelText("New note name"), "../evil.md");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText(/invalid document name/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("New note name")).toBeNull();
  });
});

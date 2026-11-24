import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Settings } from "./Settings";

const MODELS = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "Balanced quality and cost." },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "Fastest and cheapest." },
];

function settingsBody(scorerModel: string | null) {
  return {
    hasAnthropicKey: true,
    scorerModel,
    defaultScorerModel: "claude-sonnet-5-5",
    scorerModels: MODELS,
    scorerProvider: null,
    homeCountry: null,
    scanFreshnessHours: null,
    hasTheMuseKey: false,
    feedUrl: null,
    hasFeedKey: false,
  };
}

/** Serves GET /api/settings and records the body of each PUT. */
function mockSettings(scorerModel: string | null) {
  const puts: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") puts.push(JSON.parse(String(init.body)));
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(settingsBody(scorerModel)),
      });
    }),
  );
  return puts;
}

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return render(<Settings />, { wrapper });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Settings scorer model picker", () => {
  it("shows the default when no model is saved, and lists the suggested models", async () => {
    mockSettings(null);
    renderSettings();
    const select = await screen.findByLabelText("Scorer model");
    expect(select).toHaveValue("__default");
    expect(screen.getByRole("option", { name: "Default (Claude Sonnet 5.5)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Claude Haiku 5.5" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Other model…" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Model ID")).not.toBeInTheDocument();
  });

  it("saves a model picked from the list", async () => {
    const puts = mockSettings(null);
    renderSettings();
    await userEvent.selectOptions(await screen.findByLabelText("Scorer model"), "claude-haiku-5-5");
    expect(screen.getByText("Fastest and cheapest.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(puts.at(-1)?.scorerModel).toBe("claude-haiku-5-5"));
  });

  it("saves a typed model ID chosen through Other model…", async () => {
    const puts = mockSettings(null);
    renderSettings();
    await userEvent.selectOptions(await screen.findByLabelText("Scorer model"), "__custom");
    await userEvent.type(screen.getByLabelText("Model ID"), "claude-opus-4-8");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(puts.at(-1)?.scorerModel).toBe("claude-opus-4-8"));
  });

  it("opens on Other model… when the saved model isn't a suggestion", async () => {
    mockSettings("claude-opus-4-8");
    renderSettings();
    await waitFor(() => expect(screen.getByLabelText("Scorer model")).toHaveValue("__custom"));
    expect(screen.getByLabelText("Model ID")).toHaveValue("claude-opus-4-8");
  });

  it("clears the saved model when switching back to the default", async () => {
    const puts = mockSettings("claude-haiku-5-5");
    renderSettings();
    const select = await screen.findByLabelText("Scorer model");
    await waitFor(() => expect(select).toHaveValue("claude-haiku-5-5"));
    await userEvent.selectOptions(select, "__default");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(puts.at(-1)?.scorerModel).toBe(""));
  });
});

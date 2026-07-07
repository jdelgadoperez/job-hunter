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
  scanBody?: unknown;
  scoreBody?: unknown;
  latestScan?: unknown;
  /** Substrings of request URLs that should respond 500 (to exercise error-state UI). */
  failUrls?: string[];
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
    current: null,
    total: null,
    recent: [],
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
      if (bodies.failUrls?.some((fragment) => url.includes(fragment))) {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          json: () => Promise.resolve({ error: "boom" }),
        });
      }
      const body = (() => {
        if (url.includes("/api/settings")) {
          return {
            hasAnthropicKey: bodies.settings?.hasAnthropicKey ?? false,
            scorerModel: null,
            scorerProvider: null,
            homeCountry: null,
            scanFreshnessHours: null,
            hasTheMuseKey: false,
            feedUrl: null,
            hasFeedKey: false,
          };
        }
        if (url.includes("/api/score/preview")) return bodies.preview;
        if (url.includes("/api/score/status"))
          return bodies.scoreBody ?? idleScore(bodies.scoreState);
        if (url.includes("/api/score") && init?.method === "POST") return idleScore("running");
        // Check /api/scans/latest before /api/scan — the latter is a substring of the former.
        if (url.includes("/api/scans/latest")) return bodies.latestScan ?? null;
        if (url.includes("/api/scan")) return bodies.scanBody ?? idleScan(bodies.scanState);
        if (url.includes("/api/profile")) return null;
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

function runningScanBody() {
  return {
    ...idleScan("running"),
    message: "Scanning company 3 of 10…",
    current: 3,
    total: 10,
  };
}

function runningScoreBody() {
  return {
    ...idleScore("running"),
    message: "Scoring posting 5 of 20…",
    current: 5,
    total: 20,
  };
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

describe("DeepScoreCard spend gate", () => {
  const previewBody = {
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
  };

  it("disables Deep-score until a preview has been run", async () => {
    mockFetch({ settings: { hasAnthropicKey: true }, preview: previewBody });
    renderHome();

    const deepScore = await screen.findByRole("button", { name: "Deep-score" });
    expect(deepScore).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByText(/est\./i);
    expect(screen.getByRole("button", { name: "Deep-score" })).toBeEnabled();
  });

  it("re-disables Deep-score and clears the estimate when an option changes after preview", async () => {
    mockFetch({ settings: { hasAnthropicKey: true }, preview: previewBody });
    renderHome();

    await userEvent.click(await screen.findByRole("button", { name: "Preview" }));
    await screen.findByText(/est\./i);

    await userEvent.click(screen.getByRole("checkbox", { name: /remote only/i }));

    expect(screen.queryByText(/est\./i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deep-score" })).toBeDisabled();
  });
});

describe("Home scan panel — Rescan all toggle", () => {
  function findScanRequest() {
    return vi
      .mocked(fetch)
      .mock.calls.find(
        ([url, init]) =>
          typeof url === "string" && url.includes("/api/scan") && init?.method === "POST",
      );
  }

  it("sends an incremental scope by default", async () => {
    mockFetch({ settings: { hasAnthropicKey: true } });
    renderHome();

    const checkbox = await screen.findByRole("checkbox", { name: "Rescan all" });
    expect(checkbox).not.toBeChecked();

    await userEvent.click(await screen.findByRole("button", { name: "Scan now" }));

    await waitFor(() => expect(findScanRequest()).toBeDefined());
    const [, init] = findScanRequest() ?? [];
    expect(init?.body).toEqual(JSON.stringify({ scope: "incremental" }));
  });

  it("sends a full scope when Rescan all is checked", async () => {
    mockFetch({ settings: { hasAnthropicKey: true } });
    renderHome();

    const checkbox = await screen.findByRole("checkbox", { name: "Rescan all" });
    await userEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    await userEvent.click(await screen.findByRole("button", { name: "Scan now" }));

    await waitFor(() => expect(findScanRequest()).toBeDefined());
    const [, init] = findScanRequest() ?? [];
    expect(init?.body).toEqual(JSON.stringify({ scope: "full" }));
  });
});

describe("Home scan panel — warning details", () => {
  function doneScanBody(warnings: Array<{ source: string; message: string }>) {
    return {
      ...idleScan("done"),
      message: "Scan complete",
      finishedAt: "2026-06-30T00:00:00.000Z",
      warnings,
    };
  }

  it("expands warning details for a finished scan", async () => {
    mockFetch({
      settings: { hasAnthropicKey: true },
      scanBody: doneScanBody([{ source: "Acme", message: "board 500" }]),
    });
    renderHome();

    const summary = await screen.findByText(/1 warning\(s\)/i);
    expect(summary.closest("details")).not.toHaveAttribute("open");

    await userEvent.click(summary);

    expect(screen.getByText(/Acme/)).toBeInTheDocument();
    expect(screen.getByText(/board 500/)).toBeInTheDocument();
  });

  it("shows no warning details block when a scan finishes clean", async () => {
    mockFetch({
      settings: { hasAnthropicKey: true },
      scanBody: doneScanBody([]),
    });
    renderHome();

    await screen.findByText(/Scan complete/i);
    expect(screen.queryByText(/warning\(s\)/i)).not.toBeInTheDocument();
  });
});

describe("Home error states — failed fetches surface, don't masquerade as empty", () => {
  it("shows an error (not the 'no profile yet' empty state) when /api/profile fails", async () => {
    mockFetch({ settings: { hasAnthropicKey: true }, failUrls: ["/api/profile"] });
    renderHome();

    await waitFor(() => expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument());
    // The false "you have no profile" message must NOT be shown on a failed fetch.
    expect(screen.queryByText(/No profile yet/i)).not.toBeInTheDocument();
  });

  it("surfaces a scan status-poll failure instead of a silent frozen spinner", async () => {
    mockFetch({ settings: { hasAnthropicKey: true }, failUrls: ["/api/scan/status"] });
    renderHome();

    await waitFor(() =>
      expect(screen.getByText(/Lost contact with the scan/i)).toBeInTheDocument(),
    );
  });

  it("surfaces a deep-score status-poll failure instead of a silent frozen spinner", async () => {
    mockFetch({ settings: { hasAnthropicKey: true }, failUrls: ["/api/score/status"] });
    renderHome();

    await waitFor(() =>
      expect(screen.getByText(/Lost contact with the deep-score run/i)).toBeInTheDocument(),
    );
  });
});

describe("Home progress live regions — aria-atomic", () => {
  it("marks the scan progress live region atomic so message and count announce together", async () => {
    mockFetch({ settings: { hasAnthropicKey: true }, scanBody: runningScanBody() });
    renderHome();

    const region = await screen.findByText(/Scanning company 3 of 10/i);
    const live = region.closest("[aria-live]");
    expect(live).toHaveAttribute("aria-atomic", "true");
  });

  it("marks the score progress live region atomic so message and count announce together", async () => {
    mockFetch({
      settings: { hasAnthropicKey: true },
      preview: null,
      scoreBody: runningScoreBody(),
    });
    renderHome();

    const region = await screen.findByText(/Scoring posting 5 of 20/i);
    const live = region.closest("[aria-live]");
    expect(live).toHaveAttribute("aria-atomic", "true");
  });
});

describe("Home last-scan card — kind and timestamp", () => {
  function latestScan(kind: string, finishedAt: string) {
    return {
      id: 1,
      kind,
      startedAt: finishedAt,
      finishedAt,
      postingsSeen: 5,
      companiesSeen: 2,
      newCompanies: [],
      removedCompanies: [],
    };
  }

  // The kind + timestamp render as interleaved text nodes in one span, so locate the "Last scan"
  // heading and read its card's text rather than matching a single fragmented text node.
  async function lastScanCardText(): Promise<string> {
    const heading = await screen.findByRole("heading", { name: "Last scan" });
    // The card is the heading's containing <div> (the Card body).
    const card = heading.closest("div");
    return card?.textContent ?? "";
  }

  it("labels the scan kind and shows a relative timestamp", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    mockFetch({ latestScan: latestScan("incremental", twoHoursAgo) });
    renderHome();

    const text = await lastScanCardText();
    expect(text).toContain("Incremental scan");
    expect(text).toContain("2 hours ago");
  });

  it("labels a full scan distinctly from an incremental one", async () => {
    const now = new Date().toISOString();
    mockFetch({ latestScan: latestScan("full", now) });
    renderHome();

    const text = await lastScanCardText();
    expect(text).toContain("Full scan");
    expect(text).toContain("just now");
  });
});

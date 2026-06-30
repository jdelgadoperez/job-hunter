import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type SettingsView } from "./api";

function mockFetchOnce(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const response = {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: "OK",
    json: () => Promise.resolve(body),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(response)),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api response validation", () => {
  it("parses a fully-populated settings response, including the feed + Muse fields", async () => {
    const serverShape: SettingsView = {
      hasAnthropicKey: true,
      scorerModel: "claude-sonnet-4-6",
      scorerProvider: "anthropic",
      hasTheMuseKey: false,
      feedUrl: "https://feed.example.com/jobs",
      hasFeedKey: true,
    };
    mockFetchOnce(serverShape);

    await expect(api.getSettings()).resolves.toEqual(serverShape);
  });

  it("throws when the settings response is missing a field the client expects", async () => {
    // Simulates server/client contract drift: the server stopped sending the feed fields. Without
    // runtime validation this would surface as silent `undefined` in the UI; zod makes it loud.
    mockFetchOnce({
      hasAnthropicKey: true,
      scorerModel: null,
      scorerProvider: null,
      // hasTheMuseKey / feedUrl / hasFeedKey omitted
    });

    await expect(api.getSettings()).rejects.toThrow();
  });

  it("parses a matches response array", async () => {
    const matches = [
      {
        posting: {
          id: "p1",
          company: "Acme",
          title: "Engineer",
          url: "https://acme.com/jobs/1",
          source: "greenhouse",
          description: "build things",
          fetchedAt: "2026-06-30T00:00:00.000Z",
        },
        result: { score: 88, matchedSkills: ["typescript"], missingSkills: [] },
        action: null,
        expired: false,
      },
    ];
    mockFetchOnce(matches);

    const parsed = await api.getMatches(50);
    expect(parsed).toEqual(matches);
  });

  it("surfaces the server's error message on a non-2xx response", async () => {
    mockFetchOnce(
      { error: "careersUrl must start with http:// or https://" },
      {
        ok: false,
        status: 400,
      },
    );

    await expect(api.addCompany("ftp://bad")).rejects.toThrow(
      "careersUrl must start with http:// or https://",
    );
  });

  it("treats both 202 and 409 as a valid scan-status body", async () => {
    const status = {
      state: "running",
      message: null,
      current: null,
      total: null,
      count: null,
      warnings: [],
      error: null,
      startedAt: "2026-06-30T00:00:00.000Z",
      finishedAt: null,
      recent: [],
    };
    mockFetchOnce(status, { ok: false, status: 409 });

    await expect(api.startScan()).resolves.toEqual(status);
  });
});

import { assertAllowedUrl } from "./ssrf-guard";

export type FetchResponse = {
  statusCode: number;
  finalUrl: string;
  bodyText: string;
};

/** Request options for non-GET calls (e.g. Workday's POST jobs API). GET needs none. */
export type FetchInit = {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
};

/**
 * The single network seam. Every connector, source, and liveness check takes a
 * `Fetcher` so the automated suite can run against recorded fixtures with no live
 * network. `HttpFetcher` is the production default; `FakeFetcher` backs the tests.
 */
export interface Fetcher {
  fetch(url: string, init?: FetchInit): Promise<FetchResponse>;
}

const MAX_REDIRECTS = 5;

export class HttpFetcher implements Fetcher {
  private readonly fetchImpl: typeof fetch;
  private readonly assertAllowed: (url: string) => Promise<void>;

  constructor(
    private readonly timeoutMs = 15_000,
    deps: { fetchImpl?: typeof fetch; assertAllowed?: (url: string) => Promise<void> } = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.assertAllowed = deps.assertAllowed ?? assertAllowedUrl;
  }

  async fetch(url: string, init?: FetchInit): Promise<FetchResponse> {
    const method = init?.method ?? "GET";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // Follow redirects manually so every hop is SSRF-checked — a public URL must not be able to
      // redirect us onto an internal address. Only GET redirects are auto-followed; a redirected
      // POST is returned as-is (re-issuing a body to a new URL is unsafe to assume).
      let current = url;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        await this.assertAllowed(current);
        const res = await this.fetchImpl(current, {
          method,
          body: init?.body,
          headers: init?.headers,
          signal: controller.signal,
          redirect: "manual",
        });
        const location = res.headers.get("location");
        if (method === "GET" && res.status >= 300 && res.status < 400 && location) {
          current = new URL(location, current).href;
          continue;
        }
        const bodyText = await res.text();
        return { statusCode: res.status, finalUrl: current, bodyText };
      }
      throw new Error(`too many redirects fetching ${url}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class FakeFetcher implements Fetcher {
  constructor(private readonly routes: Record<string, FetchResponse>) {}

  async fetch(url: string): Promise<FetchResponse> {
    return this.routes[url] ?? { statusCode: 404, finalUrl: url, bodyText: "" };
  }
}

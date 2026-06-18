export type FetchResponse = {
  statusCode: number;
  finalUrl: string;
  bodyText: string;
};

/**
 * The single network seam. Every connector, source, and liveness check takes a
 * `Fetcher` so the automated suite can run against recorded fixtures with no live
 * network. `HttpFetcher` is the production default; `FakeFetcher` backs the tests.
 */
export interface Fetcher {
  fetch(url: string): Promise<FetchResponse>;
}

export class HttpFetcher implements Fetcher {
  constructor(private readonly timeoutMs = 15_000) {}

  async fetch(url: string): Promise<FetchResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
      const bodyText = await res.text();
      return { statusCode: res.status, finalUrl: res.url, bodyText };
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

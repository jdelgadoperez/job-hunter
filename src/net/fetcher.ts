import { assertAllowedUrl } from "./ssrf-guard";

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

const MAX_REDIRECTS = 5;

export class HttpFetcher implements Fetcher {
  constructor(private readonly timeoutMs = 15_000) {}

  async fetch(url: string): Promise<FetchResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // Follow redirects manually so every hop is SSRF-checked — a public URL must not be able to
      // redirect us onto an internal address.
      let current = url;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        await assertAllowedUrl(current);
        const res = await fetch(current, { signal: controller.signal, redirect: "manual" });
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
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

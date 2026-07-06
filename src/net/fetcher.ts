import { Agent, type Dispatcher, interceptors, fetch as undiciFetch } from "undici";
import { type AllowedUrl, assertAllowedUrl } from "./ssrf-guard";

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

/** The init we hand the underlying fetch: the standard fields we set, plus undici's non-standard
 *  `dispatcher` extension for per-request connection pinning. */
type PinnedRequestInit = {
  method: string;
  body?: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  redirect: "manual";
  dispatcher?: Dispatcher;
};

/** Just the slice of a fetch response we read. Structurally satisfied by both undici's `fetch` result
 *  and the DOM `Response` the tests fake, so the seam doesn't couple to either identity. */
type FetchResponseLike = {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
};

/** The pluggable fetch implementation. Production uses undici's `fetch` (so the pinned `Agent`
 *  dispatcher is honored — Node's global `fetch` embeds its own separate undici runtime and would
 *  reject a dispatcher from this package); tests inject a stub. */
export type FetchImpl = (url: string, init: PinnedRequestInit) => Promise<FetchResponseLike>;

/**
 * Build a dispatcher that pins the TCP connection to the exact addresses the SSRF guard already
 * validated. Without this, `assertAllowedUrl` resolves the hostname to check it, but the underlying
 * `fetch` then re-resolves it independently at connect time — a DNS-rebinding window where a
 * low-TTL record can flip from the public IP we approved to an internal one (127.0.0.1,
 * 169.254.169.254 metadata, LAN). undici's DNS interceptor feeds our pre-validated addresses to the
 * connection while keeping the original hostname for the TLS SNI servername and the Host header, so
 * certificate validation is unaffected. Returns `undefined` when the URL host is an IP literal
 * (there is nothing to re-resolve, so nothing to pin).
 */
function pinnedDispatcher(allowed: AllowedUrl): Dispatcher | undefined {
  if (allowed.addresses.length === 0) return undefined;
  const pinned = allowed.addresses;
  return new Agent().compose(
    interceptors.dns({
      lookup: (_origin, _opts, callback) => {
        // Hand back exactly the addresses the guard validated — no re-resolution at connect time.
        // ttl 0 so nothing is cached across requests; each fetch re-validates via the guard first.
        callback(
          null,
          pinned.map(({ address, family }) => ({ address, family, ttl: 0 })),
        );
      },
    }),
  );
}

export class HttpFetcher implements Fetcher {
  private readonly fetchImpl: FetchImpl;
  private readonly assertAllowed: (url: string) => Promise<AllowedUrl>;

  constructor(
    private readonly timeoutMs = 15_000,
    deps: { fetchImpl?: FetchImpl; assertAllowed?: (url: string) => Promise<AllowedUrl> } = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? undiciFetch;
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
        const allowed = await this.assertAllowed(current);
        const requestInit: PinnedRequestInit = {
          method,
          body: init?.body,
          headers: init?.headers,
          signal: controller.signal,
          redirect: "manual",
          // Pin the connection to the addresses we just validated, closing the DNS-rebinding TOCTOU.
          dispatcher: pinnedDispatcher(allowed),
        };
        const res = await this.fetchImpl(current, requestInit);
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

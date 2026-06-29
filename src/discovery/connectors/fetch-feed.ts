import { errorMessage } from "@app/net/error-message";
import type { Fetcher, FetchInit } from "@app/net/fetcher";
import type { ZodType } from "zod";

export type FeedResult<T> = { ok: true; data: T } | { ok: false; warning: string };

/**
 * The shared network boundary for every JSON feed (ATS connectors + the company
 * directory source): fetch, guard the status, parse JSON, and validate with zod —
 * returning a discriminated result instead of throwing. Centralizing it here means the
 * "degrade with a warning, never crash" contract is implemented once rather than copied
 * into each connector, and a failure is always observable to the caller. `init` carries
 * non-GET request options (e.g. Workday's POST body).
 */
export async function fetchFeed<T>(
  fetcher: Fetcher,
  url: string,
  schema: ZodType<T>,
  init?: FetchInit,
): Promise<FeedResult<T>> {
  let res: Awaited<ReturnType<Fetcher["fetch"]>>;
  try {
    res = await fetcher.fetch(url, init);
  } catch (error) {
    return { ok: false, warning: `request failed: ${errorMessage(error)}` };
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    return { ok: false, warning: `unexpected status ${res.statusCode}` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(res.bodyText);
  } catch {
    return { ok: false, warning: "response was not valid JSON" };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, warning: "response failed schema validation" };
  }

  return { ok: true, data: parsed.data };
}

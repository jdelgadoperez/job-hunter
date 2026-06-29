import type { JobPosting } from "@app/domain/types";
import type { Fetcher, FetchInit } from "@app/net/fetcher";
import pLimit from "p-limit";
import { makePostingId } from "../posting-id";
import { fetchFeed } from "./fetch-feed";
import { WorkdayFeed, WorkdayJobDetail } from "./schemas";
import type { AtsConnector, ConnectorResult } from "./types";

const PAGE_SIZE = 20;
const MAX_PAGES = 10; // bound a single company to ~200 roles
const DETAIL_CONCURRENCY = 6; // per-company cap on the follow-up description fetches

// Some Workday tenants 403 a non-browser client; present an ordinary desktop Chrome.
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const UA_HEADERS = { "user-agent": DESKTOP_UA };

type WorkdaySite = { host: string; tenant: string; site: string };
type WorkdayJobRef = { title: string; externalPath: string; locationsText?: string };

/**
 * Parse a Workday careers URL into the pieces of its CXS jobs API endpoint:
 * `https://{tenant}.{dc}.myworkdayjobs.com/[locale/]{site}` →
 * `{ host, tenant, site }`. Returns null for anything that isn't a Workday URL.
 */
export function parseWorkdayUrl(careersUrl: string): WorkdaySite | null {
  let url: URL;
  try {
    url = new URL(careersUrl);
  } catch {
    return null;
  }
  if (!url.hostname.endsWith(".myworkdayjobs.com")) return null;
  const tenant = url.hostname.split(".")[0];
  // The site is the last path segment (a leading locale like /en-US/ is ignored).
  const site = url.pathname.split("/").filter(Boolean).at(-1);
  if (!tenant || !site) return null;
  return { host: url.hostname, tenant, site };
}

/**
 * Connector for Workday-hosted boards (`*.myworkdayjobs.com`). Workday exposes a public JSON jobs
 * API (the CXS endpoint the careers SPA itself calls), so these resolve fast like the other ATS
 * connectors instead of falling to the browser. The list endpoint omits the description, so each
 * posting's detail page is fetched (bounded concurrency) to get the full text; a posting whose
 * detail can't be read falls back to title + location.
 *
 * `boardToken` here is the full careers URL (resolve-ats passes it through) since Workday needs the
 * host/tenant/site, not a single slug.
 */
export class WorkdayConnector implements AtsConnector {
  readonly source = "workday";

  async fetchPostings(careersUrl: string, fetcher: Fetcher): Promise<ConnectorResult> {
    const wd = parseWorkdayUrl(careersUrl);
    if (!wd) return { ok: false, warning: `unrecognized Workday URL: ${careersUrl}` };

    const listResult = await this.listJobs(wd, fetcher);
    if (!listResult.ok) return listResult;

    const fetchedAt = new Date();
    const limit = pLimit(DETAIL_CONCURRENCY);
    const postings = await Promise.all(
      listResult.jobs.map((job) =>
        limit(async () => {
          const url = new URL(`/${wd.site}${job.externalPath}`, `https://${wd.host}`).href;
          const description = await this.fetchDescription(wd, job, fetcher);
          return {
            id: makePostingId({ company: wd.tenant, title: job.title, url }),
            company: wd.tenant,
            title: job.title,
            url,
            source: this.source,
            description,
            location: job.locationsText,
            fetchedAt,
          } satisfies JobPosting;
        }),
      ),
    );

    return { ok: true, postings };
  }

  /** Page through the CXS jobs list, collecting job refs (title + path + location). */
  private async listJobs(
    wd: WorkdaySite,
    fetcher: Fetcher,
  ): Promise<{ ok: true; jobs: WorkdayJobRef[] } | { ok: false; warning: string }> {
    const apiUrl = `https://${wd.host}/wday/cxs/${wd.tenant}/${wd.site}/jobs`;
    const jobs: WorkdayJobRef[] = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const offset = page * PAGE_SIZE;
      const init: FetchInit = {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...UA_HEADERS },
        body: JSON.stringify({ appliedFacets: {}, limit: PAGE_SIZE, offset, searchText: "" }),
      };
      const result = await fetchFeed(fetcher, apiUrl, WorkdayFeed, init);
      if (!result.ok) {
        // A first-page failure is a real warning; a later page failing just truncates the list.
        return page === 0 ? result : { ok: true, jobs };
      }

      for (const job of result.data.jobPostings) {
        jobs.push({
          title: job.title,
          externalPath: job.externalPath,
          locationsText: job.locationsText,
        });
      }

      const fetched = offset + result.data.jobPostings.length;
      const done =
        result.data.jobPostings.length === 0 ||
        (result.data.total !== undefined && fetched >= result.data.total);
      if (done) break;
    }

    return { ok: true, jobs };
  }

  /** Fetch a job's full description from its detail endpoint; fall back to title + location. */
  private async fetchDescription(
    wd: WorkdaySite,
    job: WorkdayJobRef,
    fetcher: Fetcher,
  ): Promise<string> {
    const fallback = job.locationsText ? `${job.title} — ${job.locationsText}` : job.title;
    const detailUrl = `https://${wd.host}/wday/cxs/${wd.tenant}/${wd.site}${job.externalPath}`;
    const result = await fetchFeed(fetcher, detailUrl, WorkdayJobDetail, { headers: UA_HEADERS });
    if (!result.ok) return fallback;
    const description = result.data.jobPostingInfo.jobDescription?.trim();
    return description || fallback;
  }
}

import type { JobPosting } from "@app/domain/types";
import type { Fetcher } from "@app/net/fetcher";
import pLimit from "p-limit";
import { makePostingId } from "../posting-id";
import { fetchFeed } from "./fetch-feed";
import { SmartRecruitersDetail, SmartRecruitersFeed } from "./schemas";
import type { AtsConnector, ConnectorResult } from "./types";

const API_BASE = "https://api.smartrecruiters.com/v1/companies";
const PAGE_SIZE = 100;
const MAX_PAGES = 10; // bound a single company to ~1000 roles
const DETAIL_CONCURRENCY = 6; // per-company cap on the follow-up description fetches

type SmartRecruitersJobRef = { id: string; title: string; location?: string };

/**
 * Connector for SmartRecruiters-hosted boards (`careers.smartrecruiters.com/{slug}`). SmartRecruiters
 * exposes a public Posting API (no auth) the careers SPA itself calls. The list endpoint omits the
 * description, so each posting's detail is fetched (bounded concurrency) for the full text and its
 * canonical `postingUrl`; a posting whose detail can't be read falls back to title + location and a
 * synthesized board URL.
 *
 * `boardToken` is the company identifier (the first careers-URL path segment), which is also stamped
 * as each posting's `company` so liveness re-checks can re-derive the feed (see `connectorBySource`).
 */
export class SmartRecruitersConnector implements AtsConnector {
  readonly source = "smartrecruiters";

  async fetchPostings(slug: string, fetcher: Fetcher): Promise<ConnectorResult> {
    const listResult = await this.listJobs(slug, fetcher);
    if (!listResult.ok) return listResult;

    const fetchedAt = new Date();
    const limit = pLimit(DETAIL_CONCURRENCY);
    const postings = await Promise.all(
      listResult.jobs.map((job) =>
        limit(async () => {
          const { description, url } = await this.fetchDetail(slug, job, fetcher);
          return {
            id: makePostingId({ company: slug, title: job.title, url }),
            company: slug,
            title: job.title,
            url,
            source: this.source,
            description,
            location: job.location,
            fetchedAt,
          } satisfies JobPosting;
        }),
      ),
    );

    return { ok: true, postings };
  }

  /** Page through the postings list (offset pagination), collecting job refs. */
  private async listJobs(
    slug: string,
    fetcher: Fetcher,
  ): Promise<{ ok: true; jobs: SmartRecruitersJobRef[] } | { ok: false; warning: string }> {
    const jobs: SmartRecruitersJobRef[] = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const offset = page * PAGE_SIZE;
      const url = `${API_BASE}/${slug}/postings?limit=${PAGE_SIZE}&offset=${offset}`;
      const result = await fetchFeed(fetcher, url, SmartRecruitersFeed);
      if (!result.ok) {
        // A first-page failure is a real warning; a later page failing just truncates the list.
        return page === 0 ? result : { ok: true, jobs };
      }

      for (const posting of result.data.content) {
        jobs.push({
          id: posting.id,
          title: posting.name,
          location: posting.location?.fullLocation,
        });
      }

      const fetched = offset + result.data.content.length;
      const total = result.data.totalFound;
      const done = result.data.content.length === 0 || (total !== undefined && fetched >= total);
      if (done) break;
    }

    return { ok: true, jobs };
  }

  /**
   * Fetch a posting's full description and canonical URL from its detail endpoint. Falls back to a
   * title/location description and a synthesized board URL when the detail can't be read.
   */
  private async fetchDetail(
    slug: string,
    job: SmartRecruitersJobRef,
    fetcher: Fetcher,
  ): Promise<{ description: string; url: string }> {
    const fallbackUrl = `https://jobs.smartrecruiters.com/${slug}/${job.id}`;
    const fallbackDescription = job.location ? `${job.title} — ${job.location}` : job.title;

    const detailUrl = `${API_BASE}/${slug}/postings/${job.id}`;
    const result = await fetchFeed(fetcher, detailUrl, SmartRecruitersDetail);
    if (!result.ok) return { description: fallbackDescription, url: fallbackUrl };

    const sections = result.data.jobAd?.sections;
    const description = [sections?.jobDescription?.text, sections?.qualifications?.text]
      .filter((text): text is string => Boolean(text?.trim()))
      .join("\n\n");

    return {
      description: description || fallbackDescription,
      url: result.data.postingUrl ?? fallbackUrl,
    };
  }
}

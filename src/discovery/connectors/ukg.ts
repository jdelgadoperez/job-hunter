import type { JobPosting } from "@app/domain/types";
import type { FetchInit, Fetcher } from "@app/net/fetcher";
import { makePostingId } from "../posting-id";
import { fetchFeed } from "./fetch-feed";
import { UkgFeed } from "./schemas";
import type { AtsConnector, ConnectorResult } from "./types";

const PAGE_SIZE = 50;
const MAX_PAGES = 10; // bound a single company to ~500 roles

type UkgBoard = { origin: string; tenant: string; jobBoardId: string };

/**
 * Parse a UKG/UltiPro careers URL into the pieces of its job-board API endpoint:
 * `https://recruiting{N}.ultipro.com/{tenant}/JobBoard/{guid}/...` → `{ origin, tenant, jobBoardId }`.
 * Returns null for anything that isn't a recognizable UKG job-board URL.
 */
export function parseUkgUrl(careersUrl: string): UkgBoard | null {
  let url: URL;
  try {
    url = new URL(careersUrl);
  } catch {
    return null;
  }
  if (!url.hostname.endsWith(".ultipro.com")) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const boardIndex = segments.findIndex((segment) => segment === "JobBoard");
  const tenant = segments[0];
  const jobBoardId = segments[boardIndex + 1];
  if (boardIndex <= 0 || !tenant || !jobBoardId) return null;
  return { origin: url.origin, tenant, jobBoardId };
}

/**
 * Connector for UKG/UltiPro-hosted boards (`recruiting{N}.ultipro.com/{tenant}/JobBoard/{guid}`).
 * UKG exposes a public JSON search API (no auth) the careers SPA itself calls. Its list response
 * carries a `BriefDescription` (a real summary, not a snippet) — the full description would require
 * rendering the SPA detail page — so this is a single-call feed connector that uses `BriefDescription`
 * as the description.
 *
 * `boardToken` here is the full careers URL (resolve-ats passes it through) since UKG needs the
 * tenant + job-board GUID from the path, not a single slug.
 */
export class UkgConnector implements AtsConnector {
  readonly source = "ukg";

  async fetchPostings(careersUrl: string, fetcher: Fetcher): Promise<ConnectorResult> {
    const board = parseUkgUrl(careersUrl);
    if (!board) return { ok: false, warning: `unrecognized UKG URL: ${careersUrl}` };

    const apiUrl = `${board.origin}/${board.tenant}/JobBoard/${board.jobBoardId}/JobBoardView/LoadSearchResults`;
    const fetchedAt = new Date();
    const postings: JobPosting[] = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const skip = page * PAGE_SIZE;
      const init: FetchInit = {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          opportunitySearch: { Top: PAGE_SIZE, Skip: skip },
          matchCriteria: { PreferredJobLanguageMatch: false },
        }),
      };
      const result = await fetchFeed(fetcher, apiUrl, UkgFeed, init);
      if (!result.ok) {
        // A first-page failure is a real warning; a later page failing just truncates the list.
        return page === 0 ? result : { ok: true, postings };
      }

      for (const opportunity of result.data.opportunities) {
        const url = `${board.origin}/${board.tenant}/JobBoard/${board.jobBoardId}/OpportunityDetail?opportunityId=${opportunity.Id}`;
        const location =
          opportunity.Locations?.[0]?.LocalizedDescription ??
          opportunity.Locations?.[0]?.Address?.City ??
          undefined;
        postings.push({
          id: makePostingId({ company: board.tenant, title: opportunity.Title, url }),
          company: board.tenant,
          title: opportunity.Title,
          url,
          source: this.source,
          description: opportunity.BriefDescription?.trim() || opportunity.Title,
          location: location ?? undefined,
          fetchedAt,
        });
      }

      const fetched = skip + result.data.opportunities.length;
      const total = result.data.totalCount;
      const done =
        result.data.opportunities.length === 0 || (total !== undefined && fetched >= total);
      if (done) break;
    }

    return { ok: true, postings };
  }
}

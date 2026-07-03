import type { Fetcher } from "@app/net/fetcher";
import { fetchAtsPostings } from "./ats-feed";
import { AshbyFeed } from "./schemas";
import type { AtsConnector, ConnectorResult } from "./types";

/**
 * Ashby's `isRemote` is true for BOTH Remote and Hybrid location types, so it can't be trusted to
 * mean "fully remote". `workplaceType` ("Remote" | "Hybrid" | "OnSite") is authoritative when
 * present — a Hybrid role is NOT remote. Fall back to `isRemote` only when workplaceType is absent.
 */
export function ashbyRemote(
  workplaceType: string | undefined,
  isRemote: boolean | undefined,
): boolean | undefined {
  if (workplaceType !== undefined) return workplaceType === "Remote";
  return isRemote;
}

export class AshbyConnector implements AtsConnector {
  readonly source = "ashby";

  fetchPostings(boardToken: string, fetcher: Fetcher): Promise<ConnectorResult> {
    return fetchAtsPostings(fetcher, {
      source: this.source,
      boardToken,
      url: `https://api.ashbyhq.com/posting-api/job-board/${boardToken}`,
      schema: AshbyFeed,
      jobs: (feed) => feed.jobs,
      map: (job) => ({
        title: job.title,
        url: job.jobUrl,
        description: job.descriptionPlain ?? "",
        location: job.location,
        remote: ashbyRemote(job.workplaceType, job.isRemote),
      }),
    });
  }
}

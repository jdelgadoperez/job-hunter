import { fetchFeed } from "@app/discovery/connectors/fetch-feed";
import { z } from "zod";
import type { CompanyLead } from "./types";
import type { LeadSource, LeadSourceDeps, LeadSourceResult } from "./types";

const SOURCE = "remotive";
const URL = "https://remotive.com/api/remote-jobs";

// Lenient on unknown fields; strict only on what we read. Remotive returns one row per job.
const RemotiveJob = z
  .object({
    company_name: z.string(),
    url: z.string(),
    category: z.string().optional(),
  })
  .passthrough();

const RemotiveFeed = z.object({ jobs: z.array(RemotiveJob) }).passthrough();

/**
 * Remotive remote-jobs aggregator (`remotive.com/api/remote-jobs`, free/no-auth) as a `LeadSource`.
 * Emits one `CompanyLead` per job — staying "dumb" about ATS platforms; `resolve-ats` classifies each
 * URL downstream, and `collectLeads`' URL dedup collapses repeats. Degrades to a `Warning`, never throws.
 */
export class RemotiveSource implements LeadSource {
  readonly name = SOURCE;

  async fetch(deps: LeadSourceDeps): Promise<LeadSourceResult> {
    const result = await fetchFeed(deps.fetcher, URL, RemotiveFeed);
    if (!result.ok) {
      return { leads: [], warnings: [{ source: SOURCE, message: result.warning }] };
    }
    const leads: CompanyLead[] = result.data.jobs.map((job) => ({
      company: job.company_name,
      careersUrl: job.url,
      categories: job.category ? [job.category] : [],
    }));
    return { leads, warnings: [] };
  }
}

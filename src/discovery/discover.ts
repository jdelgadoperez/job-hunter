import type { JobPosting, SkillProfile, Warning } from "@app/domain/types";
import type { Fetcher } from "@app/net/fetcher";
import pLimit from "p-limit";
import { BrowserConnector, type PageRenderer } from "./connectors/browser";
import { resolveAts } from "./resolve-ats";
import { type CompanyLead, discoverCompanies } from "./sources/stillhiring";

export type DiscoverDeps = {
  fetcher: Fetcher;
  renderer: PageRenderer;
  concurrency?: number;
  delayMs?: number;
};

export type DiscoverResult = {
  postings: JobPosting[];
  warnings: Warning[];
};

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Network-bound entry point: discover companies, then resolve and fetch each one's
 * postings (ATS connector when recognized, browser fallback otherwise). Politeness
 * is enforced by a concurrency cap and an inter-request delay, both injectable.
 * Per-company failures become `Warning`s and never abort the run — discovery always
 * returns partial results.
 */
export async function discover(profile: SkillProfile, deps: DiscoverDeps): Promise<DiscoverResult> {
  const { fetcher, renderer } = deps;
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  const delayMs = deps.delayMs ?? DEFAULT_DELAY_MS;

  const { leads, warnings } = await discoverCompanies(profile, fetcher);
  const browser = new BrowserConnector();
  const byId = new Map<string, JobPosting>();
  const limit = pLimit(concurrency);

  const fetchLead = async (lead: CompanyLead): Promise<JobPosting[]> => {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    const resolved = resolveAts(lead.careersUrl);
    if (resolved) {
      return resolved.connector.fetchPostings(resolved.boardToken, fetcher);
    }
    return browser.fetchPostings(lead.careersUrl, lead.company, renderer);
  };

  const settled = await Promise.all(
    leads.map((lead) =>
      limit(async () => {
        try {
          return { lead, postings: await fetchLead(lead) };
        } catch (error) {
          return { lead, error };
        }
      }),
    ),
  );

  for (const result of settled) {
    if ("error" in result) {
      warnings.push({
        source: result.lead.company,
        message: result.error instanceof Error ? result.error.message : String(result.error),
      });
      continue;
    }
    for (const posting of result.postings) {
      byId.set(posting.id, posting);
    }
  }

  return { postings: [...byId.values()], warnings };
}

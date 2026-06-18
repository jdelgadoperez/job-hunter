import type { JobPosting, SkillProfile, Warning } from "@app/domain/types";
import type { Fetcher } from "@app/net/fetcher";
import pLimit from "p-limit";
import { BrowserConnector, type PageRenderer } from "./connectors/browser";
import type { ConnectorResult } from "./connectors/types";
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
 * postings (ATS connector when recognized, browser fallback otherwise). Politeness is
 * enforced by a concurrency cap and an inter-request delay, both injectable. Connector
 * failures (and any thrown error) become `Warning`s and never abort the run — discovery
 * always returns partial results.
 */
export async function discover(profile: SkillProfile, deps: DiscoverDeps): Promise<DiscoverResult> {
  const { fetcher, renderer } = deps;
  // Floor the cap at 1: `?? DEFAULT` keeps a literal 0, and pLimit(0) throws.
  const concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
  const delayMs = deps.delayMs ?? DEFAULT_DELAY_MS;

  const { leads, warnings } = await discoverCompanies(profile, fetcher);
  const browser = new BrowserConnector();
  const byId = new Map<string, JobPosting>();
  const limit = pLimit(concurrency);

  // Space request *starts* by delayMs without holding a concurrency slot during the
  // wait, so the cap bounds in-flight requests rather than serializing the dead time.
  let gate = Promise.resolve();
  const waitTurn = (): Promise<void> => {
    if (delayMs <= 0) {
      return Promise.resolve();
    }
    const next = gate.then(() => sleep(delayMs));
    gate = next;
    return next;
  };

  const fetchLead = async (lead: CompanyLead): Promise<ConnectorResult> => {
    const resolved = resolveAts(lead.careersUrl);
    if (resolved) {
      return resolved.connector.fetchPostings(resolved.boardToken, fetcher);
    }
    const postings = await browser.fetchPostings(lead.careersUrl, lead.company, renderer);
    return { ok: true, postings };
  };

  const collected = await Promise.all(
    leads.map(async (lead) => {
      await waitTurn();
      return limit(async (): Promise<{ lead: CompanyLead; result: ConnectorResult }> => {
        try {
          return { lead, result: await fetchLead(lead) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { lead, result: { ok: false, warning: message } };
        }
      });
    }),
  );

  for (const { lead, result } of collected) {
    if (!result.ok) {
      warnings.push({ source: lead.company, message: result.warning });
      continue;
    }
    for (const posting of result.postings) {
      byId.set(posting.id, posting);
    }
  }

  return { postings: [...byId.values()], warnings };
}

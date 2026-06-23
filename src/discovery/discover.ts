import type { ScanProgressEvent } from "@app/domain/scan-progress";
import type { JobPosting, Warning } from "@app/domain/types";
import type { Fetcher } from "@app/net/fetcher";
import pLimit from "p-limit";
import { BrowserConnector, type PageRenderer } from "./connectors/browser";
import type { ConnectorResult } from "./connectors/types";
import { resolveAts } from "./resolve-ats";
import { type SharedViewReader, airtableRowsToLeads } from "./sources/airtable";
import type { CompanyLead } from "./sources/types";

export type DiscoverDeps = {
  fetcher: Fetcher;
  renderer: PageRenderer;
  /** Reads the stillhiring Airtable shared view (production: Playwright). */
  sharedViewReader: SharedViewReader;
  /** The Airtable shared-view URL. */
  shareUrl: string;
  /** User-tracked companies, merged with the Airtable directory. */
  trackedCompanies?: { careersUrl: string; name?: string }[];
  /** Optional live progress callback (directory read, per-company visits). */
  onProgress?: (event: ScanProgressEvent) => void;
  concurrency?: number;
  delayMs?: number;
};

export type DiscoverResult = {
  postings: JobPosting[];
  warnings: Warning[];
  /** The merged, de-duplicated company list this run scanned (directory + tracked). */
  companies: CompanyLead[];
};

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Stable key for de-duplicating leads that point at the same careers page. */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.replace(/\/$/, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * Build the company lead list from the Airtable shared view + user-tracked companies, merged and
 * de-duplicated by normalized careers URL. An unreachable Airtable degrades to tracked-only plus a
 * `Warning` — never throws.
 */
async function collectLeads(
  deps: DiscoverDeps,
): Promise<{ leads: CompanyLead[]; warnings: Warning[] }> {
  const warnings: Warning[] = [];

  let airtableLeads: CompanyLead[] = [];
  try {
    const raw = await deps.sharedViewReader.read(deps.shareUrl);
    const mapped = airtableRowsToLeads(raw);
    airtableLeads = mapped.leads;
    if (mapped.warning) warnings.push({ source: "airtable", message: mapped.warning });
  } catch (error) {
    warnings.push({
      source: "airtable",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const trackedLeads: CompanyLead[] = (deps.trackedCompanies ?? []).map((tracked) => ({
    company: tracked.name ?? hostnameOf(tracked.careersUrl),
    careersUrl: tracked.careersUrl,
    categories: [],
  }));

  const byUrl = new Map<string, CompanyLead>();
  for (const lead of [...airtableLeads, ...trackedLeads]) {
    const key = normalizeUrl(lead.careersUrl);
    if (!byUrl.has(key)) byUrl.set(key, lead);
  }

  return { leads: [...byUrl.values()], warnings };
}

/**
 * Network-bound entry point: discover companies (Airtable directory + tracked), then resolve and
 * fetch each one's postings (ATS connector when recognized, browser fallback otherwise).
 * Politeness is enforced by a concurrency cap and an inter-request delay, both injectable.
 * Connector failures (and any thrown error) become `Warning`s and never abort the run — discovery
 * always returns partial results.
 */
export async function discover(deps: DiscoverDeps): Promise<DiscoverResult> {
  const { fetcher, renderer } = deps;
  // Floor the cap at 1: `?? DEFAULT` keeps a literal 0, and pLimit(0) throws.
  const concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
  const delayMs = deps.delayMs ?? DEFAULT_DELAY_MS;

  deps.onProgress?.({ kind: "directory" });
  const { leads, warnings } = await collectLeads(deps);
  deps.onProgress?.({ kind: "leads", total: leads.length });

  const browser = new BrowserConnector();
  const byId = new Map<string, JobPosting>();
  const limit = pLimit(concurrency);
  let started = 0;

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
        started += 1;
        deps.onProgress?.({
          kind: "company",
          name: lead.company,
          index: started,
          total: leads.length,
        });
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

  return { postings: [...byId.values()], warnings, companies: leads };
}

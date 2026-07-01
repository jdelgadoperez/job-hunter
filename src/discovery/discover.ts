import { hostnameOf, normalizeCareersUrl } from "@app/domain/normalize";
import type { ScanProgressEvent } from "@app/domain/scan-progress";
import type { JobPosting, Warning } from "@app/domain/types";
import type { SettingsReader } from "@app/matching/resolve-settings";
import { errorMessage } from "@app/net/error-message";
import type { Fetcher } from "@app/net/fetcher";
import pLimit from "p-limit";
import { BrowserConnector, type PageRenderer } from "./connectors/browser";
import type { ConnectorResult } from "./connectors/types";
import { resolveAts } from "./resolve-ats";
import type { SharedViewReader } from "./sources/airtable";
import { LEAD_SOURCES } from "./sources/registry";
import type { CompanyLead, LeadSource } from "./sources/types";
import { isUnscrapableHost } from "./unscrapable";

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
  /** Settings reader for key-gated lead sources (threaded to each source). */
  settings: SettingsReader;
  /** Lead sources to run; defaults to the production registry. Injected for tests. */
  sources?: LeadSource[];
  /** Normalized careers URLs to exclude from the retry pass (still attempted on the main pass). */
  skipRetryFor?: Set<string>;
};

export type DiscoverResult = {
  postings: JobPosting[];
  warnings: Warning[];
  /** The merged, de-duplicated company list this run scanned (directory + tracked). */
  companies: CompanyLead[];
  /** Companies on hosts we don't scrape (LinkedIn/Indeed/…), surfaced for manual review. */
  skipped: CompanyLead[];
};

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the company lead list by fanning out over all registered lead sources plus user-tracked
 * companies, merged and de-duplicated by normalized careers URL. Sources run in registry order so
 * first-wins dedup is deterministic. Any source failure degrades to a `Warning` — never throws.
 */
async function collectLeads(
  deps: DiscoverDeps,
): Promise<{ leads: CompanyLead[]; warnings: Warning[] }> {
  const warnings: Warning[] = [];
  const sources = deps.sources ?? LEAD_SOURCES;

  const sourceDeps = {
    fetcher: deps.fetcher,
    settings: deps.settings,
    sharedViewReader: deps.sharedViewReader,
    shareUrl: deps.shareUrl,
  };

  const sourceLeads: CompanyLead[] = [];
  // Sources run in registry order so first-wins dedup is deterministic. Each degrades to warnings.
  const results = await Promise.all(
    sources.map((source) =>
      source.fetch(sourceDeps).catch((error) => ({
        leads: [],
        warnings: [{ source: source.name, message: errorMessage(error) }],
      })),
    ),
  );
  for (const result of results) {
    sourceLeads.push(...result.leads);
    warnings.push(...result.warnings);
  }

  const trackedLeads: CompanyLead[] = (deps.trackedCompanies ?? []).map((tracked) => ({
    company: tracked.name ?? hostnameOf(tracked.careersUrl),
    careersUrl: tracked.careersUrl,
    categories: [],
  }));

  const byUrl = new Map<string, CompanyLead>();
  for (const lead of [...sourceLeads, ...trackedLeads]) {
    const key = normalizeCareersUrl(lead.careersUrl);
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
    // Hosts we don't scrape (LinkedIn/Indeed/…) would just be a ~30s headless timeout returning
    // nothing — skip the render; they're surfaced for manual review via `skipped`.
    if (isUnscrapableHost(lead.careersUrl)) {
      return { ok: true, postings: [] };
    }
    const postings = await browser.fetchPostings(lead.careersUrl, lead.company, renderer);
    return { ok: true, postings };
  };

  const failed: { lead: CompanyLead; result: Extract<ConnectorResult, { ok: false }> }[] = [];
  try {
    const collected = await Promise.all(
      leads.map(async (lead) => {
        await waitTurn();
        return limit(async (): Promise<{ lead: CompanyLead; result: ConnectorResult }> => {
          started += 1;
          deps.onProgress?.({
            kind: "company",
            name: lead.company,
            // Same-named employers can appear under several distinct boards; the host disambiguates
            // them in the progress line (e.g. "LawnStarter (boards.greenhouse.io)").
            host: hostnameOf(lead.careersUrl),
            index: started,
            total: leads.length,
          });
          try {
            return { lead, result: await fetchLead(lead) };
          } catch (error) {
            return { lead, result: { ok: false, warning: errorMessage(error) } };
          }
        });
      }),
    );

    for (const { lead, result } of collected) {
      if (!result.ok) {
        failed.push({ lead, result });
        continue;
      }
      for (const posting of result.postings) {
        byId.set(posting.id, posting);
      }
    }

    if (failed.length > 0) {
      const skipRetryFor = deps.skipRetryFor ?? new Set<string>();
      const toRetry = failed.filter(
        ({ lead }) => !skipRetryFor.has(normalizeCareersUrl(lead.careersUrl)),
      );
      const retried = await Promise.all(
        toRetry.map(async ({ lead }) => {
          await waitTurn();
          return limit(async (): Promise<{ lead: CompanyLead; result: ConnectorResult }> => {
            try {
              return { lead, result: await fetchLead(lead) };
            } catch (error) {
              return { lead, result: { ok: false, warning: errorMessage(error) } };
            }
          });
        }),
      );
      const retriedUrls = new Set(toRetry.map(({ lead }) => normalizeCareersUrl(lead.careersUrl)));
      for (const { lead, result } of retried) {
        if (!result.ok) {
          warnings.push({
            source: lead.company,
            message: result.warning,
            careersUrl: lead.careersUrl,
          });
          continue;
        }
        for (const posting of result.postings) {
          byId.set(posting.id, posting);
        }
      }
      // Anything skipped (in skipRetryFor) keeps its original main-pass warning.
      for (const { lead, result } of failed) {
        if (retriedUrls.has(normalizeCareersUrl(lead.careersUrl))) continue;
        warnings.push({
          source: lead.company,
          message: result.warning,
          careersUrl: lead.careersUrl,
        });
      }
    }
  } finally {
    // Release the shared headless browser (if the run used the browser fallback) once, after all
    // renders are done — main pass AND retry pass — rather than launching and closing one per
    // company or per pass.
    await renderer.dispose?.();
  }

  const skipped = leads.filter((lead) => isUnscrapableHost(lead.careersUrl));
  if (skipped.length > 0) {
    warnings.push({
      source: "directory",
      message: `Skipped ${skipped.length} companies on sites we don't scrape (LinkedIn/Indeed) — review them manually.`,
    });
  }

  return { postings: [...byId.values()], warnings, companies: leads, skipped };
}

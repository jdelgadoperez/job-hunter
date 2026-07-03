import { hostnameOf, normalizeCareersUrl } from "@app/domain/normalize";
import type { ScanProgressEvent } from "@app/domain/scan-progress";
import type { JobPosting, Warning } from "@app/domain/types";
import type { SettingsReader } from "@app/matching/resolve-settings";
import { errorMessage } from "@app/net/error-message";
import type { Fetcher } from "@app/net/fetcher";
import { withTimeout } from "@app/net/with-timeout";
import pLimit from "p-limit";
import { makeCompanyId } from "./company-id";
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
  /** Optional wall-clock budget (ms) for the whole crawl. Once exceeded, discover stops starting new
   *  leads and skips the retry pass, returning partial results with `truncated: true` and a warning —
   *  so a growing directory degrades to a partial feed instead of blowing a hard job timeout. The
   *  hosted worker sets this below its runner timeout; local scans leave it unset (no budget). */
  budgetMs?: number;
  /** Injectable clock for the budget (default `Date.now`); tests drive it to force truncation. */
  now?: () => number;
  /** Settings reader for key-gated lead sources (threaded to each source). */
  settings: SettingsReader;
  /** Lead sources to run; defaults to the production registry. Injected for tests. */
  sources?: LeadSource[];
  /** Normalized careers URLs to exclude from the retry pass (still attempted on the main pass). */
  skipRetryFor?: Set<string>;
  /** Normalized careers URLs to skip among DIRECTORY leads (an incremental scan's fresh companies).
   *  Tracked companies are never skipped. */
  skipCareersUrls?: Set<string>;
};

export type DiscoverResult = {
  postings: JobPosting[];
  warnings: Warning[];
  /** The merged, de-duplicated company list this run scanned (directory + tracked). */
  companies: CompanyLead[];
  /** Companies on hosts we don't scrape (LinkedIn/Indeed/…), surfaced for manual review. */
  skipped: CompanyLead[];
  /** True when the crawl stopped early because `budgetMs` was reached: some leads were not crawled
   *  this run. They remain in `companies` (the directory diff is unaffected), but the caller should
   *  skip the liveness re-check — "not seen this scan" no longer means "gone". */
  truncated: boolean;
};

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_DELAY_MS = 250;
/** Cap for the post-crawl browser teardown. Closing the shared headless browser should be near-
 *  instant; if it ever hangs, this bounds the wait to a few seconds (then degrades to a warning)
 *  instead of a silent stall that runs the run's clock down to the job timeout. */
const DISPOSE_TIMEOUT_MS = 15_000;

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

  // An incremental scan skips directory companies crawled recently. Applied to SOURCE leads only —
  // tracked companies are always crawled (a user who just added one expects it scanned now).
  const skip = deps.skipCareersUrls;
  const keptSourceLeads = skip
    ? sourceLeads.filter((lead) => !skip.has(normalizeCareersUrl(lead.careersUrl)))
    : sourceLeads;

  const byUrl = new Map<string, CompanyLead>();
  for (const lead of [...keptSourceLeads, ...trackedLeads]) {
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

  // Wall-clock budget: a safety valve so the crawl always finishes and persists within the runner's
  // job timeout instead of being hard-killed mid-crawl. Started here so it bounds the whole run.
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const overBudget = (): boolean =>
    deps.budgetMs !== undefined && now() - startedAt >= deps.budgetMs;

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
  // Leads we never attempted because the wall-clock budget ran out mid-crawl (a `null` result below).
  let skippedOverBudget = 0;
  try {
    const collected = await Promise.all(
      leads.map(async (lead) => {
        await waitTurn();
        // `null` result === skipped because the budget is spent (distinct from a crawl failure).
        return limit(async (): Promise<{ lead: CompanyLead; result: ConnectorResult | null }> => {
          if (overBudget()) {
            return { lead, result: null };
          }
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
      if (result === null) {
        skippedOverBudget += 1;
        continue;
      }
      if (!result.ok) {
        failed.push({ lead, result });
        continue;
      }
      for (const posting of result.postings) {
        byId.set(posting.id, { ...posting, companyId: makeCompanyId(lead.careersUrl) });
      }
    }

    // Retry the failed leads once — unless the budget is spent (skip the expensive, slow second pass)
    // or a lead is explicitly skip-listed. Unlike the main pass, the retry pass emits progress too, so
    // a long retry over hundreds of failures is visible in the logs rather than a silent stall.
    const skipRetryFor = deps.skipRetryFor ?? new Set<string>();
    const toRetry = overBudget()
      ? []
      : failed.filter(({ lead }) => !skipRetryFor.has(normalizeCareersUrl(lead.careersUrl)));
    let retryStarted = 0;
    const retried = await Promise.all(
      toRetry.map(async ({ lead }) => {
        await waitTurn();
        return limit(async (): Promise<{ lead: CompanyLead; result: ConnectorResult }> => {
          retryStarted += 1;
          deps.onProgress?.({
            kind: "company",
            name: lead.company,
            host: hostnameOf(lead.careersUrl),
            index: retryStarted,
            total: toRetry.length,
          });
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
        byId.set(posting.id, { ...posting, companyId: makeCompanyId(lead.careersUrl) });
      }
    }
    // Anything not retried (skip-listed, or skipped because the budget ran out) keeps its main-pass
    // warning so the failure is still surfaced.
    for (const { lead, result } of failed) {
      if (retriedUrls.has(normalizeCareersUrl(lead.careersUrl))) continue;
      warnings.push({
        source: lead.company,
        message: result.warning,
        careersUrl: lead.careersUrl,
      });
    }
  } finally {
    // Release the shared headless browser (if the run used the browser fallback) once, after all
    // renders are done — main pass AND retry pass — rather than launching and closing one per
    // company or per pass. Bounded by a timeout and never fatal: a hung teardown must not silently
    // burn the run's remaining clock (nor discard the postings we just crawled) — it degrades to a
    // warning, same as any other crawl failure.
    if (renderer.dispose) {
      try {
        await withTimeout(
          Promise.resolve(renderer.dispose()),
          DISPOSE_TIMEOUT_MS,
          "renderer.dispose",
        );
      } catch (error) {
        warnings.push({ source: "directory", message: `Browser cleanup: ${errorMessage(error)}` });
      }
    }
  }

  const skipped = leads.filter((lead) => isUnscrapableHost(lead.careersUrl));
  if (skipped.length > 0) {
    warnings.push({
      source: "directory",
      message: `Skipped ${skipped.length} companies on sites we don't scrape (LinkedIn/Indeed) — review them manually.`,
    });
  }

  const truncated = skippedOverBudget > 0;
  if (truncated) {
    warnings.push({
      source: "directory",
      message: `Time budget reached — crawled ${started}/${leads.length} companies this run; the remaining ${skippedOverBudget} will be picked up next run.`,
    });
  }

  return { postings: [...byId.values()], warnings, companies: leads, skipped, truncated };
}

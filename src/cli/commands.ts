import { makeCompanyId } from "@app/discovery/company-id";
import { type DiscoverDeps, discover } from "@app/discovery/discover";
import type { PostingFeed } from "@app/discovery/feed/posting-feed";
import type { ScanScope, ScanStore } from "@app/discovery/scan-store";
import type { CompanyLead } from "@app/discovery/sources/types";
import type { ScanProgressEvent } from "@app/domain/scan-progress";
import type { JobPosting, Scorer, SkillProfile, Warning } from "@app/domain/types";
import { detectLiveness } from "@app/freshness/detect-liveness";
import { fetchLivenessSignalsForBoard } from "@app/freshness/fetch-liveness";
import { parseCountry } from "@app/matching/location-filter";
import { resolveHomeCountry } from "@app/matching/resolve-settings";
import type { ScoreOutcome } from "@app/matching/score-run";
import { HOME_COUNTRY_SETTING } from "@app/matching/settings-keys";
import { errorMessage } from "@app/net/error-message";
import type { Fetcher } from "@app/net/fetcher";
import { buildProfile } from "@app/profile/build-profile";
import { detectHomeCountry } from "@app/profile/detect-home-country";
import type { CompanyRef, Repository } from "@app/storage/repository";
import pLimit from "p-limit";
import { scoreBadge, style } from "./style";

export type Logger = (message: string) => void;

export function trackAdd(
  repo: Repository,
  url: string,
  name: string | undefined,
  log: Logger,
): void {
  repo.addTrackedCompany(url, name);
  log(style.success(`Tracking ${name ? `${name} (${url})` : url}`));
}

export function trackList(repo: Repository, log: Logger): void {
  const companies = repo.listTrackedCompanies();
  if (companies.length === 0) {
    log(style.dim("No tracked companies. Add one with `job-hunter track add <careers-url>`."));
    return;
  }
  for (const company of companies) {
    const url = style.url(company.careersUrl);
    log(company.name ? `- ${style.bold(company.name)} — ${url}` : `- ${url}`);
  }
}

export function trackRemove(repo: Repository, url: string, log: Logger): void {
  log(
    repo.removeTrackedCompany(url)
      ? style.success(`Removed ${url}`)
      : style.warn(`Not tracked: ${url}`),
  );
}

export type ProfileDeps = {
  repo: Repository;
  /** Injected so tests don't read a real file; defaults to the resume reader in production. */
  readResume: (filePath: string) => Promise<string>;
};

export async function runProfile(
  deps: ProfileDeps,
  resumePath: string,
  log: Logger,
): Promise<SkillProfile> {
  const resumeText = await deps.readResume(resumePath);
  const dictionary = deps.repo.getSkillDictionary();
  const profile = buildProfile({
    resumeText,
    dictionary: dictionary.length > 0 ? dictionary : undefined,
  });
  deps.repo.saveProfile(profile);
  const detected = detectHomeCountry(resumeText, resolveHomeCountry(deps.repo));
  if (detected !== undefined) deps.repo.setSetting(HOME_COUNTRY_SETTING, detected);
  log(
    style.success(`Saved profile: ${profile.skills.length} skill(s) extracted from ${resumePath}.`),
  );
  return profile;
}

export type ScanDeps = {
  repo: Repository;
  profile: SkillProfile;
  scorer: Scorer;
  discoverDeps: DiscoverDeps;
  /** Optional remote feed; when set, the scan sources in hybrid remote mode (see `runSourcing`). */
  feed?: PostingFeed;
  /** Optional structured progress (directory read, per-company, scoring, summary). */
  onProgress?: (event: ScanProgressEvent) => void;
  /** `"retry"` runs a scoped rescan (only the given tracked companies): no directory bookkeeping,
   * and the in-run retry pass is NOT skip-listed (those companies are exactly what we want to
   * retry). Defaults to `"full"`. */
  scope?: ScanScope;
};

export type ScanOutcome = {
  count: number;
  warnings: Warning[];
  /** Directory companies that appeared / disappeared vs. the previous scan. */
  newCompanies: CompanyRef[];
  removedCompanies: CompanyRef[];
  /** Postings marked expired this run (gone from their board across consecutive scans). */
  expired: number;
};

/** Dependencies for the sourcing-only pipeline — no scorer, no profile (the worker has neither). */
export type SourcingDeps = {
  repo: ScanStore;
  discoverDeps: DiscoverDeps;
  /**
   * Optional remote feed. When set, the scan runs in **hybrid remote mode**: pull the shared feed
   * AND locally crawl only the user's tracked companies (the cloud worker already covers the shared
   * directory). When absent, run the full local crawl.
   */
  feed?: PostingFeed;
  onProgress?: (event: ScanProgressEvent) => void;
  /** `"retry"` scopes the run to the crawled subset: no removed-diff, no liveness re-check, no
   * expiry, and the scan is recorded as a retry so it's excluded from the staleness clock.
   * Defaults to `"full"` (the normal whole-directory scan and the hosted worker). */
  scope?: ScanScope;
  /**
   * On a `"retry"` scan, restricts the shared feed to postings whose `companyId` is in this set (the
   * needs-attention companies). A posting with no `companyId` is never matched — `undefined` means
   * "unknown", not "wildcard". Absent (the full-scan default) applies no filtering.
   */
  companyIdFilter?: Set<string>;
  /**
   * The needs-attention companies the filter above was built from, so the feed side can report which
   * of them actually recovered this run (see `SourcingOutcome.recoveredFromFeed`).
   */
  needsAttention?: CompanyRef[];
};

/** Result of a sourcing run: the postings + companies seen, the directory diff, and expiry count. */
export type SourcingOutcome = {
  scanId: number;
  postings: JobPosting[];
  companies: CompanyLead[];
  warnings: Warning[];
  newCompanies: CompanyRef[];
  removedCompanies: CompanyRef[];
  expired: number;
  /** Needs-attention companies whose postings reappeared in the shared feed this run — cleared from
   * `failed_leads` by `runScan` even though they weren't locally crawled. */
  recoveredFromFeed?: CompanyRef[];
};

/**
 * The shared **sourcing** half of a scan: open a scan, snapshot+diff the directory, upsert postings
 * (stamping the scan), re-check liveness, expire vanished postings, and record the outcome — with
 * **no scoring**. Depends only on a `ScanStore`, so the same pipeline drives the local SQLite scan
 * and the hosted Postgres scanner worker. Never logs; the caller decides how to surface the result.
 */
export async function runSourcing(deps: SourcingDeps): Promise<SourcingOutcome> {
  const { repo, feed, onProgress } = deps;
  const scope = deps.scope ?? "full";
  // `await` every store call: a no-op for the synchronous SQLite Repository, but required for an
  // async Postgres-backed store (both satisfy the ScanStore seam).
  const scanId = await repo.startScan(scope);

  // Remote mode (feed set): pull the shared feed AND crawl only tracked companies locally. Otherwise
  // run the full local crawl. Both yield postings + the companies to snapshot + any warnings.
  const { postings, companies, warnings, recoveredFromFeed } = feed
    ? await sourceFromFeedAndTracked(
        feed,
        deps.discoverDeps,
        onProgress,
        deps.companyIdFilter,
        deps.needsAttention,
      )
    : await sourceFromFullCrawl(deps.discoverDeps, onProgress);

  // A scoped retry only crawls a subset, so the whole-directory removed-diff would flag every
  // uncrawled healthy company as "gone". Skip it; still upsert the crawled companies.
  const diff = await repo.recordDirectory(
    scanId,
    companies.map((c) => ({ careersUrl: c.careersUrl, name: c.company })),
    { computeRemoved: scope === "full" },
  );

  // Enrich each posting with a normalized country derived from its location string — but only when
  // it doesn't already carry one. A feed-sourced posting may arrive with an authoritative country
  // from upstream; re-parsing its (looser) location string could overwrite that with a worse value,
  // so we never clobber an existing country. parseCountry is conservative: undefined when unparseable.
  const enriched = postings.map((p) => {
    if (p.country !== undefined) return p;
    const country = parseCountry(p.location);
    return country !== undefined ? { ...p, country } : p;
  });

  // The write phase is silent and, for a network-backed store, the slowest part of a crawl — emit a
  // progress event so a stall here is visible rather than looking frozen after the last company.
  onProgress?.({ kind: "persisting", total: enriched.length });
  // Prefer one bulk round-trip when the store offers it (the Postgres worker); fall back to the
  // serial upsert for the synchronous SQLite Repository, which has no per-row round-trip cost.
  if (repo.savePostings) await repo.savePostings(enriched, scanId);
  else for (const posting of enriched) await repo.savePosting(posting, scanId);

  // Precise liveness re-check: postings we didn't see this scan get their source re-fetched and are
  // expired immediately when confirmed gone (404 / removed from the board), rather than waiting for
  // the consecutive-miss heuristic. "unknown" (unreachable) is left for that heuristic backstop.
  // A scoped retry refreshes only the companies it crawled; it must not re-check or expire the
  // postings of companies it never looked at (that treats "not seen this scan" as "gone").
  const expired =
    scope === "full"
      ? (await recheckLiveness(repo, scanId, deps.discoverDeps.fetcher, onProgress)) +
        (await repo.expireStalePostings(scanId))
      : 0;
  await repo.finishScan(scanId, {
    postingsSeen: postings.length,
    companiesSeen: companies.length,
    ...diff,
  });

  return { scanId, postings, companies, warnings, expired, recoveredFromFeed, ...diff };
}

type SourceResult = {
  postings: JobPosting[];
  companies: CompanyLead[];
  warnings: Warning[];
  recoveredFromFeed?: CompanyRef[];
};

/** Full local crawl: the directory sources + tracked companies (today's default behavior). */
async function sourceFromFullCrawl(
  discoverDeps: DiscoverDeps,
  onProgress?: (event: ScanProgressEvent) => void,
): Promise<SourceResult> {
  const { postings, warnings, companies = [] } = await discover({ ...discoverDeps, onProgress });
  return { postings, companies, warnings };
}

/**
 * Hybrid remote mode: the shared feed plus a local crawl of ONLY the user's tracked companies.
 * `sources: []` makes `collectLeads` contribute just the tracked companies, so the client skips the
 * shared directory the cloud worker already crawls. Feed + local postings merge by id (a posting in
 * both — e.g. a tracked company also in the feed — collapses to one).
 *
 * `companyIdFilter`, when present (a `"retry"` scan), restricts the feed to postings belonging to
 * needs-attention companies: a posting passes only when it carries a `companyId` AND that id is in
 * the filter. A posting with no `companyId` is dropped under a filter — NULL means "unknown", never
 * "wildcard" — but a full scan (no filter) never drops feed postings, companyId or not.
 * `needsAttention` (the same companies the filter was built from) lets us report which of them
 * actually reappeared in the (filtered) feed this run, so `runScan` can clear them from
 * `failed_leads` even though they weren't locally crawled.
 */
async function sourceFromFeedAndTracked(
  feed: PostingFeed,
  discoverDeps: DiscoverDeps,
  onProgress?: (event: ScanProgressEvent) => void,
  companyIdFilter?: Set<string>,
  needsAttention?: CompanyRef[],
): Promise<SourceResult> {
  const feedResult = await feed.fetch();
  const feedPostings = companyIdFilter
    ? feedResult.postings.filter(
        (p) => p.companyId !== undefined && companyIdFilter.has(p.companyId),
      )
    : feedResult.postings;
  const local = await discover({ ...discoverDeps, sources: [], onProgress });
  const byId = new Map<string, JobPosting>();
  for (const posting of [...feedPostings, ...local.postings]) byId.set(posting.id, posting);

  const feedCompanyIds = new Set(
    feedPostings.map((p) => p.companyId).filter((id) => id !== undefined),
  );
  const recoveredFromFeed = needsAttention?.filter((c) =>
    feedCompanyIds.has(makeCompanyId(c.careersUrl)),
  );

  return {
    postings: [...byId.values()],
    companies: local.companies ?? [],
    warnings: [...feedResult.warnings, ...local.warnings],
    ...(recoveredFromFeed ? { recoveredFromFeed } : {}),
  };
}

/**
 * Run a full local scan: source postings (`runSourcing`), then score every one with the injected
 * scorer (the free heuristic in `scan`), and report the outcome. Scoring is the only thing this adds
 * over `runSourcing`; everything sourcing-related lives there so the hosted worker can reuse it.
 */
export async function runScan(deps: ScanDeps, log: Logger): Promise<ScanOutcome> {
  const { onProgress, repo } = deps;
  const scope = deps.scope ?? "full";

  // Full scans skip re-hammering known-bad companies in discovery's in-run retry pass. A scoped
  // `--retry-failed` run is the opposite: those companies are exactly what we want to retry, so
  // the skip-list is empty there.
  const skipRetryFor = scope === "full" ? new Set(repo.listRetrySkipUrls()) : new Set<string>();

  // A retry scan scopes the shared feed to exactly the needs-attention companies, so it never
  // re-surfaces unrelated feed postings under a scoped rescan. Derived here (not by the caller) so
  // both scoped entry points (the CLI's `--retry-failed` and the scheduled retry runner) get this
  // for free without passing anything extra.
  const needsAttention = scope === "retry" ? repo.listNeedsAttention() : [];
  const companyIdFilter =
    scope === "retry" ? new Set(needsAttention.map((c) => makeCompanyId(c.careersUrl))) : undefined;

  const sourced = await runSourcing({
    repo,
    discoverDeps: { ...deps.discoverDeps, skipRetryFor },
    ...(deps.feed ? { feed: deps.feed } : {}),
    scope,
    onProgress,
    ...(companyIdFilter ? { companyIdFilter, needsAttention } : {}),
  });

  onProgress?.({ kind: "scoring", total: sourced.postings.length });
  // Score concurrently (bounded): each `score` is a network-bound LLM call, so a small cap turns a
  // serial wait into parallel throughput without hammering the provider. SQLite writes are
  // synchronous, so the `saveMatchResult` calls can't interleave mid-statement.
  const scoreLimit = pLimit(SCORE_CONCURRENCY);
  await Promise.all(
    sourced.postings.map((posting) =>
      scoreLimit(async () => {
        repo.saveMatchResult(posting.id, await deps.scorer.score(deps.profile, posting));
      }),
    ),
  );

  const perCompanyFailures = sourced.warnings
    .filter((w): w is Warning & { careersUrl: string } => w.careersUrl !== undefined)
    // `Warning.source` carries the company label for careersUrl-bearing per-company warnings,
    // set by `discover()` from `lead.company`.
    .map((w) => ({ careersUrl: w.careersUrl, company: w.source, message: w.message }));
  // "Attempted" includes companies actually crawled AND needs-attention companies that recovered
  // via the (filtered) shared feed without being locally crawled — both are "we now know this
  // company's status this run" and should be eligible for a failed_leads clear.
  const attemptedUrls = [
    ...sourced.companies.map((c) => c.careersUrl),
    ...(sourced.recoveredFromFeed ?? []).map((c) => c.careersUrl),
  ];
  try {
    repo.recordScanFailures(sourced.scanId, perCompanyFailures, attemptedUrls);
  } catch (error) {
    // Failures degrade, never crash: the scan itself already succeeded by this point.
    log(style.warn(`  ! Failed to record scan-failure history: ${errorMessage(error)}`));
  }

  onProgress?.({ kind: "summary", count: sourced.postings.length });
  log(style.success(`Scanned and scored ${sourced.postings.length} posting(s).`));
  if (sourced.newCompanies.length || sourced.removedCompanies.length || sourced.expired) {
    log(
      `  Directory: ${style.success(`+${sourced.newCompanies.length} new`)}, ${style.warn(`-${sourced.removedCompanies.length} gone`)}; expired ${sourced.expired} posting(s).`,
    );
  }
  for (const warning of sourced.warnings) {
    log(style.warn(`  ! [${warning.source}] ${warning.message}`));
  }
  return {
    count: sourced.postings.length,
    warnings: sourced.warnings,
    newCompanies: sourced.newCompanies,
    removedCompanies: sourced.removedCompanies,
    expired: sourced.expired,
  };
}

const SCORE_CONCURRENCY = 4;
const RECHECK_CONCURRENCY = 4;

/**
 * Re-fetch the liveness of postings not seen in this scan and expire the ones confirmed gone.
 * Bounded by a small concurrency cap; a failed/inconclusive re-check ("unknown") is left untouched
 * for the consecutive-miss heuristic. Returns how many were expired.
 */
async function recheckLiveness(
  repo: ScanStore,
  scanId: number,
  fetcher: Fetcher,
  onProgress?: (event: ScanProgressEvent) => void,
): Promise<number> {
  const candidates = await repo.listLivePostingsNotSeen(scanId);
  if (candidates.length === 0) return 0;
  onProgress?.({ kind: "recheck", total: candidates.length });

  // Group by board (source + company) so each ATS feed is fetched once, not once per stale posting.
  const groups = new Map<string, { source: string; company: string; postings: JobPosting[] }>();
  for (const posting of candidates) {
    const key = `${posting.source} ${posting.company}`;
    const group = groups.get(key);
    if (group) group.postings.push(posting);
    else groups.set(key, { source: posting.source, company: posting.company, postings: [posting] });
  }

  const limit = pLimit(RECHECK_CONCURRENCY);
  const expiredCounts = await Promise.all(
    [...groups.values()].map((group) =>
      limit(async () => {
        const signals = await fetchLivenessSignalsForBoard(
          group.source,
          group.company,
          group.postings,
          { fetcher },
        );
        let expired = 0;
        for (const posting of group.postings) {
          const signal = signals.get(posting.id);
          if (!signal || detectLiveness(signal) !== "expired") continue;
          if (await repo.markPostingExpired(posting.id)) expired += 1;
        }
        return expired;
      }),
    ),
  );
  return expiredCounts.reduce((total, count) => total + count, 0);
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** A human-readable plan/summary for a `score` run (dry-run preview or post-run report). */
export function formatScorePlan(
  outcome: ScoreOutcome,
  opts: { remoteOnly: boolean; limit: number; dryRun: boolean },
): string {
  const { counts, estimate } = outcome;
  const lines = [
    style.bold(opts.dryRun ? "Score plan (dry run)" : "Score run"),
    `  In DB:              ${counts.inDb} postings`,
    `  Heuristic-gated:    ${counts.afterHeuristic}`,
    `  Remote → LLM:       ${counts.afterRemote} remain   (remote_only=${opts.remoteOnly ? "on" : "off"})`,
    ...(counts.remotePenalized > 0
      ? [
          `  Non-remote:         ${counts.remotePenalized} kept, ranked lower (penalized heuristic, no LLM)`,
        ]
      : []),
    `  Already LLM-scored: ${counts.alreadyScoredSkipped} skipped   (--rescore to re-score)`,
    `  Cap (--limit ${opts.limit}):   ${counts.afterCap} selected   (of those not yet scored)`,
    `  Triage:             ${estimate.triageTitles} titles (${estimate.triageBatches} batch(es))   est. ~${usd(estimate.triageUsd)}`,
    `  Deep-score (max):   ${estimate.deepScores}                 est. ~${usd(estimate.deepScoreUsd)}`,
    `  Estimated total:                          ~${usd(estimate.totalUsd)}`,
  ];
  if (!opts.dryRun) {
    lines.push(`  Deep-scored:        ${counts.deepScored}`);
    if (outcome.abortedOnLimit) {
      lines.push(style.warn("  ! Stopped early — provider usage limit reached."));
    }
  } else {
    lines.push(style.dim("  (estimate only — no LLM calls made; rates are approximate)"));
  }
  return lines.join("\n");
}

export function listMatches(
  repo: Repository,
  minScore: number,
  log: Logger,
  opts: {
    remoteOnly?: boolean;
    country?: string;
    includeApplied?: boolean;
    onlyApplied?: boolean;
  } = {},
): void {
  const scored = repo.listScoredPostings(minScore, {
    remoteOnly: opts.remoteOnly,
    country: opts.country,
    includeApplied: opts.includeApplied,
    onlyApplied: opts.onlyApplied,
  });
  if (scored.length === 0) {
    log(style.dim("No matches yet. Run `job-hunter scan` first."));
    return;
  }
  for (const { posting, result } of scored) {
    log(
      `${scoreBadge(result.score)} ${style.bold(posting.title)} — ${posting.company}  ${style.url(posting.url)}`,
    );
  }
}

import { type DiscoverDeps, discover } from "@app/discovery/discover";
import type { PostingFeed } from "@app/discovery/feed/posting-feed";
import type { ScanStore } from "@app/discovery/scan-store";
import type { CompanyLead } from "@app/discovery/sources/types";
import type { ScanProgressEvent } from "@app/domain/scan-progress";
import type { JobPosting, Scorer, SkillProfile, Warning } from "@app/domain/types";
import { detectLiveness } from "@app/freshness/detect-liveness";
import { fetchLivenessSignal } from "@app/freshness/fetch-liveness";
import { parseCountry } from "@app/matching/location-filter";
import type { ScoreOutcome } from "@app/matching/score-run";
import type { Fetcher } from "@app/net/fetcher";
import { buildProfile } from "@app/profile/build-profile";
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
};

/** Result of a sourcing run: the postings + companies seen, the directory diff, and expiry count. */
export type SourcingOutcome = {
  postings: JobPosting[];
  companies: CompanyLead[];
  warnings: Warning[];
  newCompanies: CompanyRef[];
  removedCompanies: CompanyRef[];
  expired: number;
};

/**
 * The shared **sourcing** half of a scan: open a scan, snapshot+diff the directory, upsert postings
 * (stamping the scan), re-check liveness, expire vanished postings, and record the outcome — with
 * **no scoring**. Depends only on a `ScanStore`, so the same pipeline drives the local SQLite scan
 * and the hosted Postgres scanner worker. Never logs; the caller decides how to surface the result.
 */
export async function runSourcing(deps: SourcingDeps): Promise<SourcingOutcome> {
  const { repo, feed, onProgress } = deps;
  // `await` every store call: a no-op for the synchronous SQLite Repository, but required for an
  // async Postgres-backed store (both satisfy the ScanStore seam).
  const scanId = await repo.startScan();

  // Remote mode (feed set): pull the shared feed AND crawl only tracked companies locally. Otherwise
  // run the full local crawl. Both yield postings + the companies to snapshot + any warnings.
  const { postings, companies, warnings } = feed
    ? await sourceFromFeedAndTracked(feed, deps.discoverDeps, onProgress)
    : await sourceFromFullCrawl(deps.discoverDeps, onProgress);

  const diff = await repo.recordDirectory(
    scanId,
    companies.map((c) => ({ careersUrl: c.careersUrl, name: c.company })),
  );

  // Enrich each posting with a normalized country derived from its location string.
  // parseCountry is conservative: returns undefined when the location is unrecognizable.
  const enriched = postings.map((p) => {
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
  const recheckedExpired = await recheckLiveness(
    repo,
    scanId,
    deps.discoverDeps.fetcher,
    onProgress,
  );

  const expired = recheckedExpired + (await repo.expireStalePostings(scanId));
  await repo.finishScan(scanId, {
    postingsSeen: postings.length,
    companiesSeen: companies.length,
    ...diff,
  });

  return { postings, companies, warnings, expired, ...diff };
}

type SourceResult = { postings: JobPosting[]; companies: CompanyLead[]; warnings: Warning[] };

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
 */
async function sourceFromFeedAndTracked(
  feed: PostingFeed,
  discoverDeps: DiscoverDeps,
  onProgress?: (event: ScanProgressEvent) => void,
): Promise<SourceResult> {
  const feedResult = await feed.fetch();
  const local = await discover({ ...discoverDeps, sources: [], onProgress });
  const byId = new Map<string, JobPosting>();
  for (const posting of [...feedResult.postings, ...local.postings]) byId.set(posting.id, posting);
  return {
    postings: [...byId.values()],
    companies: local.companies ?? [],
    warnings: [...feedResult.warnings, ...local.warnings],
  };
}

/**
 * Run a full local scan: source postings (`runSourcing`), then score every one with the injected
 * scorer (the free heuristic in `scan`), and report the outcome. Scoring is the only thing this adds
 * over `runSourcing`; everything sourcing-related lives there so the hosted worker can reuse it.
 */
export async function runScan(deps: ScanDeps, log: Logger): Promise<ScanOutcome> {
  const { onProgress, repo } = deps;

  const sourced = await runSourcing({
    repo,
    discoverDeps: deps.discoverDeps,
    ...(deps.feed ? { feed: deps.feed } : {}),
    onProgress,
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

  const limit = pLimit(RECHECK_CONCURRENCY);
  const results = await Promise.all(
    candidates.map((posting) =>
      limit(async () => {
        const signal = await fetchLivenessSignal(posting, { fetcher });
        return detectLiveness(signal) === "expired"
          ? await repo.markPostingExpired(posting.id)
          : false;
      }),
    ),
  );
  return results.filter(Boolean).length;
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
    `  Remote filter:      ${counts.afterRemote} remain   (remote_only=${opts.remoteOnly ? "on" : "off"})`,
    `  Cap (--limit ${opts.limit}):   ${counts.afterCap} selected`,
    `  Already LLM-scored: ${counts.alreadyScoredSkipped} skipped   (--rescore to re-score)`,
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

export function listMatches(repo: Repository, minScore: number, log: Logger): void {
  const scored = repo.listScoredPostings(minScore);
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

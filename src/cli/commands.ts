import { type DiscoverDeps, discover } from "@app/discovery/discover";
import type { ScanProgressEvent } from "@app/domain/scan-progress";
import type { Scorer, SkillProfile, Warning } from "@app/domain/types";
import { detectLiveness } from "@app/freshness/detect-liveness";
import { fetchLivenessSignal } from "@app/freshness/fetch-liveness";
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

/**
 * Run a full scan as an incremental step: open a scan, snapshot+diff the directory, upsert and
 * score postings (stamping the scan), expire postings that have vanished, and record the outcome.
 */
export async function runScan(deps: ScanDeps, log: Logger): Promise<ScanOutcome> {
  const { onProgress, repo } = deps;
  const scanId = repo.startScan();

  const {
    postings,
    warnings,
    companies = [],
  } = await discover({ ...deps.discoverDeps, onProgress });
  const diff = repo.recordDirectory(
    scanId,
    companies.map((c) => ({ careersUrl: c.careersUrl, name: c.company })),
  );

  onProgress?.({ kind: "scoring", total: postings.length });
  for (const posting of postings) {
    repo.savePosting(posting, scanId);
    repo.saveMatchResult(posting.id, await deps.scorer.score(deps.profile, posting));
  }

  // Precise liveness re-check: postings we didn't see this scan get their source re-fetched and are
  // expired immediately when confirmed gone (404 / removed from the board), rather than waiting for
  // the consecutive-miss heuristic. "unknown" (unreachable) is left for that heuristic backstop.
  const recheckedExpired = await recheckLiveness(
    repo,
    scanId,
    deps.discoverDeps.fetcher,
    onProgress,
  );

  const expired = recheckedExpired + repo.expireStalePostings(scanId);
  repo.finishScan(scanId, {
    postingsSeen: postings.length,
    companiesSeen: companies.length,
    ...diff,
  });

  onProgress?.({ kind: "summary", count: postings.length });
  log(style.success(`Scanned and scored ${postings.length} posting(s).`));
  if (diff.newCompanies.length || diff.removedCompanies.length || expired) {
    log(
      `  Directory: ${style.success(`+${diff.newCompanies.length} new`)}, ${style.warn(`-${diff.removedCompanies.length} gone`)}; expired ${expired} posting(s).`,
    );
  }
  for (const warning of warnings) {
    log(style.warn(`  ! [${warning.source}] ${warning.message}`));
  }
  return { count: postings.length, warnings, ...diff, expired };
}

const RECHECK_CONCURRENCY = 4;

/**
 * Re-fetch the liveness of postings not seen in this scan and expire the ones confirmed gone.
 * Bounded by a small concurrency cap; a failed/inconclusive re-check ("unknown") is left untouched
 * for the consecutive-miss heuristic. Returns how many were expired.
 */
async function recheckLiveness(
  repo: Repository,
  scanId: number,
  fetcher: Fetcher,
  onProgress?: (event: ScanProgressEvent) => void,
): Promise<number> {
  const candidates = repo.listLivePostingsNotSeen(scanId);
  if (candidates.length === 0) return 0;
  onProgress?.({ kind: "recheck", total: candidates.length });

  const limit = pLimit(RECHECK_CONCURRENCY);
  const results = await Promise.all(
    candidates.map((posting) =>
      limit(async () => {
        const signal = await fetchLivenessSignal(posting, { fetcher });
        return detectLiveness(signal) === "expired" ? repo.markPostingExpired(posting.id) : false;
      }),
    ),
  );
  return results.filter(Boolean).length;
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

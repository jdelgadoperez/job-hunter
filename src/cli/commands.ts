import { type DiscoverDeps, discover } from "@app/discovery/discover";
import type { ScanProgressEvent } from "@app/domain/scan-progress";
import type { Scorer, SkillProfile, Warning } from "@app/domain/types";
import { buildProfile } from "@app/profile/build-profile";
import type { CompanyRef, Repository } from "@app/storage/repository";

export type Logger = (message: string) => void;

export function trackAdd(
  repo: Repository,
  url: string,
  name: string | undefined,
  log: Logger,
): void {
  repo.addTrackedCompany(url, name);
  log(`Tracking ${name ? `${name} (${url})` : url}`);
}

export function trackList(repo: Repository, log: Logger): void {
  const companies = repo.listTrackedCompanies();
  if (companies.length === 0) {
    log("No tracked companies. Add one with `job-hunter track add <careers-url>`.");
    return;
  }
  for (const company of companies) {
    log(company.name ? `- ${company.name} — ${company.careersUrl}` : `- ${company.careersUrl}`);
  }
}

export function trackRemove(repo: Repository, url: string, log: Logger): void {
  log(repo.removeTrackedCompany(url) ? `Removed ${url}` : `Not tracked: ${url}`);
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
  log(`Saved profile: ${profile.skills.length} skill(s) extracted from ${resumePath}.`);
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

  const expired = repo.expireStalePostings(scanId);
  repo.finishScan(scanId, {
    postingsSeen: postings.length,
    companiesSeen: companies.length,
    ...diff,
  });

  onProgress?.({ kind: "summary", count: postings.length });
  log(`Scanned and scored ${postings.length} posting(s).`);
  if (diff.newCompanies.length || diff.removedCompanies.length || expired) {
    log(
      `  Directory: +${diff.newCompanies.length} new, -${diff.removedCompanies.length} gone; expired ${expired} posting(s).`,
    );
  }
  for (const warning of warnings) {
    log(`  ! [${warning.source}] ${warning.message}`);
  }
  return { count: postings.length, warnings, ...diff, expired };
}

export function listMatches(repo: Repository, minScore: number, log: Logger): void {
  const scored = repo.listScoredPostings(minScore);
  if (scored.length === 0) {
    log("No matches yet. Run `job-hunter scan` first.");
    return;
  }
  for (const { posting, result } of scored) {
    log(`[${result.score}] ${posting.title} — ${posting.company}  ${posting.url}`);
  }
}

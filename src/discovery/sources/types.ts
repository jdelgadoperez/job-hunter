/** A company to scan: a careers URL plus a display name and optional categories. */
export type CompanyLead = {
  company: string;
  careersUrl: string;
  categories: string[];
};

import type { Warning } from "@app/domain/types";
import type { SettingsReader } from "@app/matching/resolve-settings";
import type { Fetcher } from "@app/net/fetcher";
import type { SharedViewReader } from "./airtable";

/** What a lead source returns: its leads plus any non-fatal warnings (it never throws). */
export type LeadSourceResult = { leads: CompanyLead[]; warnings: Warning[] };

/** Everything a lead source may need. Sources use only what they require (Remotive ignores most). */
export type LeadSourceDeps = {
  fetcher: Fetcher;
  /** For key-gated sources; a source with no key self-skips with a warning. */
  settings: SettingsReader;
  /** The Airtable shared-view reader (only the Airtable source uses these two). */
  sharedViewReader: SharedViewReader;
  shareUrl: string;
};

/**
 * A discovery lead source: produces `CompanyLead`s from some directory/aggregator. Contract mirrors
 * the connectors' — degrade to a `Warning`, never throw. Sources stay "dumb" about ATS specifics:
 * emit a careers URL and let `resolve-ats` classify it.
 */
export interface LeadSource {
  readonly name: string;
  /**
   * A personal source runs only on the user's own local scans: its leads stay in the local DB and
   * are never published to the shared hosted feed. The hosted worker drops these (`sharedOnly`), and
   * hybrid remote mode crawls them locally next to tracked companies (`personalOnly`), since the
   * feed can't contain them. Absent/false means a shared, public directory source.
   */
  readonly personal?: boolean;
  fetch(deps: LeadSourceDeps): Promise<LeadSourceResult>;
}

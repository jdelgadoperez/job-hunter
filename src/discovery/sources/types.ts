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
  fetch(deps: LeadSourceDeps): Promise<LeadSourceResult>;
}

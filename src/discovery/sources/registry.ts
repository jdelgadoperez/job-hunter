import { AirtableSource } from "./airtable-source";
import { RemotiveSource } from "./remotive";
import { TheMuseSource } from "./themuse";
import type { LeadSource } from "./types";

// One shared stateless instance per source, like connectors/registry.ts.
export const airtableSource = new AirtableSource();
export const remotiveSource = new RemotiveSource();
export const theMuseSource = new TheMuseSource();

/**
 * Lead sources a full local crawl runs, in priority order. Order decides which lead wins a
 * normalized-URL collision (first-wins, as in `collectLeads`); Airtable is first as the canonical
 * directory. The Muse is `personal` (see `LeadSource.personal`): local scans only, never the hosted
 * feed. It calls the API keyless unless a key is configured.
 */
export const LEAD_SOURCES: LeadSource[] = [airtableSource, remotiveSource, theMuseSource];

/** The sources whose leads may be published to the shared feed (what the hosted worker runs). */
export function sharedOnly(sources: LeadSource[]): LeadSource[] {
  return sources.filter((source) => !source.personal);
}

/** The sources that run only on a user's own machine (what hybrid mode crawls locally). */
export function personalOnly(sources: LeadSource[]): LeadSource[] {
  return sources.filter((source) => source.personal === true);
}

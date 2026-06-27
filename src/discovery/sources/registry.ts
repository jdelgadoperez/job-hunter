import { AirtableSource } from "./airtable-source";
import { RemotiveSource } from "./remotive";
import { TheMuseSource } from "./themuse";
import type { LeadSource } from "./types";

// One shared stateless instance per source, like connectors/registry.ts.
export const airtableSource = new AirtableSource();
export const remotiveSource = new RemotiveSource();
export const theMuseSource = new TheMuseSource();

/**
 * Lead sources run on every scan, in priority order. Order decides which lead wins a normalized-URL
 * collision (first-wins, as in `collectLeads`); Airtable is first as the canonical directory. The
 * Muse is registered unconditionally and self-skips when its API key is unset.
 */
export const LEAD_SOURCES: LeadSource[] = [airtableSource, remotiveSource, theMuseSource];

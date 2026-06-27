import { AirtableSource } from "./airtable-source";
import { RemotiveSource } from "./remotive";
import type { LeadSource } from "./types";

// One shared stateless instance per source, like connectors/registry.ts.
export const airtableSource = new AirtableSource();
export const remotiveSource = new RemotiveSource();

/**
 * Lead sources run on every scan, in priority order. Order decides which lead wins a normalized-URL
 * collision (first-wins, as in `collectLeads`); Airtable is first as the canonical directory.
 */
export const LEAD_SOURCES: LeadSource[] = [airtableSource, remotiveSource];

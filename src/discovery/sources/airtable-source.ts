import { errorMessage } from "@app/net/error-message";
import { airtableRowsToLeads } from "./airtable";
import type { LeadSource, LeadSourceDeps, LeadSourceResult } from "./types";

const SOURCE = "airtable";

/**
 * The stillhiring.today directory as a `LeadSource`. Reads the Airtable shared view and maps it with
 * `airtableRowsToLeads`. An unreachable view or an unexpected shape degrades to empty leads plus a
 * `Warning` — never throws. (Extracted verbatim from `collectLeads`'s former inline Airtable read.)
 */
export class AirtableSource implements LeadSource {
  readonly name = SOURCE;

  async fetch(deps: LeadSourceDeps): Promise<LeadSourceResult> {
    try {
      const raw = await deps.sharedViewReader.read(deps.shareUrl);
      const mapped = airtableRowsToLeads(raw);
      const warnings = mapped.warning ? [{ source: SOURCE, message: mapped.warning }] : [];
      return { leads: mapped.leads, warnings };
    } catch (error) {
      return { leads: [], warnings: [{ source: SOURCE, message: errorMessage(error) }] };
    }
  }
}

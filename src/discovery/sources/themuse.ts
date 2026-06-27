import { fetchFeed } from "@app/discovery/connectors/fetch-feed";
import { THE_MUSE_KEY_SETTING } from "@app/matching/settings-keys";
import { z } from "zod";
import type { CompanyLead, LeadSource, LeadSourceDeps, LeadSourceResult } from "./types";

const SOURCE = "themuse";
const BASE_URL = "https://api-v2.themuse.com/jobs";
const MAX_PAGES = 10; // bound on page-following so a large catalogue can't loop indefinitely.

// Lenient on unknown fields; strict only on what we read. The Muse returns one row per listing,
// with the careers link under `refs.landing_page` and `page_count` total pages for pagination.
const MuseListing = z
  .object({
    company: z.object({ name: z.string() }).passthrough().optional(),
    refs: z.object({ landing_page: z.string() }).passthrough().optional(),
    categories: z.array(z.object({ name: z.string() }).passthrough()).optional(),
  })
  .passthrough();

const MusePage = z
  .object({
    results: z.array(MuseListing),
    page_count: z.number().optional(),
  })
  .passthrough();

/**
 * The Muse jobs aggregator (`api-v2.themuse.com/jobs`) as a key-gated `LeadSource`. Mirrors the LLM
 * scorer's no-key fallback: with no `theMuseApiKey` setting it self-skips with a `Warning` and makes
 * no request, so it can be registered unconditionally. Emits one `CompanyLead` per listing that has a
 * landing page — staying "dumb" about ATS platforms; `resolve-ats` classifies each URL downstream and
 * `collectLeads`' dedup collapses repeats. A page failure mid-pagination keeps the leads gathered so
 * far plus a warning. Never throws.
 */
export class TheMuseSource implements LeadSource {
  readonly name = SOURCE;

  async fetch(deps: LeadSourceDeps): Promise<LeadSourceResult> {
    const key = deps.settings.getSetting(THE_MUSE_KEY_SETTING)?.trim();
    if (!key) {
      return {
        leads: [],
        warnings: [{ source: SOURCE, message: "no API key configured; skipping" }],
      };
    }

    const leads: CompanyLead[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = `${BASE_URL}?api_key=${encodeURIComponent(key)}&page=${page}`;
      const result = await fetchFeed(deps.fetcher, url, MusePage);
      if (!result.ok) {
        return { leads, warnings: [{ source: SOURCE, message: result.warning }] };
      }
      for (const listing of result.data.results) {
        const careersUrl = listing.refs?.landing_page;
        const company = listing.company?.name;
        if (!careersUrl || !company) continue; // a listing with no link or company can't become a lead.
        leads.push({
          company,
          careersUrl,
          categories: (listing.categories ?? []).map((c) => c.name),
        });
      }
      const pageCount = result.data.page_count ?? page + 1;
      if (page + 1 >= pageCount) break;
    }

    return { leads, warnings: [] };
  }
}

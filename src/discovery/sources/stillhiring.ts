import type { SkillProfile, Warning } from "@app/domain/types";
import type { Fetcher } from "@app/net/fetcher";
import { z } from "zod";
import { fetchFeed } from "../connectors/fetch-feed";

export const STILLHIRING_URL = "https://stillhiring.today/api/companies.json";

const StillHiringFeed = z
  .object({
    companies: z.array(
      z
        .object({
          name: z.string(),
          careersUrl: z.string(),
          categories: z.array(z.string()).default([]),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type CompanyLead = {
  company: string;
  careersUrl: string;
  categories: string[];
};

export type DiscoverCompaniesResult = {
  leads: CompanyLead[];
  warnings: Warning[];
};

/**
 * Fetch the stillhiring.today directory and return company leads whose categories
 * intersect the profile's (or all leads when the profile lists no categories). Any
 * fetch/parse failure degrades to `{ leads: [], warnings: [...] }` — never throws.
 */
export async function discoverCompanies(
  profile: SkillProfile,
  fetcher: Fetcher,
): Promise<DiscoverCompaniesResult> {
  const result = await fetchFeed(fetcher, STILLHIRING_URL, StillHiringFeed);
  if (!result.ok) {
    return { leads: [], warnings: [{ source: "stillhiring.today", message: result.warning }] };
  }

  const wanted = new Set(profile.categories.map((c) => c.toLowerCase()));
  const leads = result.data.companies
    .filter(
      (company) => wanted.size === 0 || company.categories.some((c) => wanted.has(c.toLowerCase())),
    )
    .map((company) => ({
      company: company.name,
      careersUrl: company.careersUrl,
      categories: company.categories,
    }));

  return { leads, warnings: [] };
}

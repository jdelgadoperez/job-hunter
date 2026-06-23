import { hostnameOf } from "@app/domain/normalize";
import { z } from "zod";
import type { CompanyLead } from "./types";

/**
 * Reads the stillhiring.today company directory, which is published as a **public Airtable
 * shared view** (there is no JSON API — the previous `stillhiring/api/companies.json` connector
 * was built against an endpoint that does not exist).
 *
 * `SharedViewReader` is the injectable seam: the production `PlaywrightSharedViewReader`
 * (see `airtable-playwright.ts`) loads the share in a real browser and captures the embed's own
 * `readSharedViewData` response, so Airtable supplies the access policy. `airtableRowsToLeads`
 * is the pure transform from that response to `CompanyLead`s.
 *
 * ⚠️ The shape below and the test fixture are the **documented/observed** Airtable
 * `readSharedViewData` structure, but have NOT yet been validated against a live capture from
 * this environment (egress is blocked here). Run `npm run smoke:airtable` on a networked machine
 * to capture a real response, replace the fixture, and confirm this schema. The mapping degrades
 * to `{ leads: [], warning }` on any mismatch, so a wrong assumption surfaces as a warning rather
 * than silently producing garbage.
 */

/**
 * The community-maintained stillhiring.today shared view. This is fixed — every install reads the
 * same public directory — so it's a constant rather than user config. `AIRTABLE_SHARE_URL` can
 * override it for development/testing, but normal use never needs to set anything.
 */
export const COMMUNITY_SHARE_URL =
  "https://airtable.com/appPGrJqA2zH65k5I/shrI8dno1rMGKZM8y/tblKU0jQiyIX182uU";

/** The shared-view URL to scan: the community table, or the `AIRTABLE_SHARE_URL` dev override. */
export function resolveShareUrl(): string {
  return process.env.AIRTABLE_SHARE_URL?.trim() || COMMUNITY_SHARE_URL;
}

/** Default column names in stillhiring's table (from the shared schema screenshot). */
const DEFAULT_CAREERS_FIELD = "Jobs Page";

const Column = z.object({ id: z.string(), name: z.string() }).passthrough();
const Row = z
  .object({
    id: z.string().optional(),
    cellValuesByColumnId: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();

// Airtable nests rows under `data.rows` in some responses and `data.table.rows` in others;
// accept either.
const SharedViewData = z
  .object({
    data: z
      .object({
        table: z.object({ columns: z.array(Column), rows: z.array(Row).optional() }).passthrough(),
        rows: z.array(Row).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type SharedViewData = z.infer<typeof SharedViewData>;

export interface SharedViewReader {
  read(shareUrl: string): Promise<unknown>;
}

/** Test double: returns a canned response, or throws to simulate a read failure. */
export class FakeSharedViewReader implements SharedViewReader {
  constructor(private readonly response: unknown) {}
  async read(_shareUrl: string): Promise<unknown> {
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }
}

export type AirtableFieldMapping = {
  /** Column holding the careers URL. Defaults to "Jobs Page". */
  careersUrlField?: string;
  /** Column holding the company name. Defaults to the table's first (primary) column. */
  companyField?: string;
};

export type AirtableLeadsResult = { leads: CompanyLead[]; warning?: string };

/** Coerce an Airtable cell value (string | number | link object | array) to a trimmed string. */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map(cellToString)
      .filter((s) => s.length > 0)
      .join(", ");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["url", "label", "name", "text", "value"]) {
      const candidate = record[key];
      if (typeof candidate === "string") return candidate.trim();
    }
  }
  return "";
}

/**
 * Map a parsed `readSharedViewData` response to company leads. Resolves the careers-URL column
 * by name (default "Jobs Page") and the company column by name (default the primary/first
 * column). Rows without a careers URL are skipped; categories are intentionally dropped (the
 * table has no clean category column — ranking is the matcher's job). Degrades to a warning.
 */
export function airtableRowsToLeads(
  raw: unknown,
  mapping: AirtableFieldMapping = {},
): AirtableLeadsResult {
  const parsed = SharedViewData.safeParse(raw);
  if (!parsed.success) {
    return { leads: [], warning: "unexpected Airtable shared-view response shape" };
  }

  const { columns } = parsed.data.data.table;
  const rows = parsed.data.data.rows ?? parsed.data.data.table.rows ?? [];

  const careersFieldName = mapping.careersUrlField ?? DEFAULT_CAREERS_FIELD;
  const careersCol = columns.find(
    (c) => c.name.trim().toLowerCase() === careersFieldName.toLowerCase(),
  );
  if (!careersCol) {
    return { leads: [], warning: `Airtable column "${careersFieldName}" not found` };
  }

  const resolvedCompanyCol = mapping.companyField
    ? columns.find((c) => c.name.trim().toLowerCase() === mapping.companyField?.toLowerCase())
    : columns[0];
  // Never name a company after its own careers-URL column (degenerate single-column case).
  const companyCol =
    resolvedCompanyCol && resolvedCompanyCol.id !== careersCol.id ? resolvedCompanyCol : undefined;

  const leads: CompanyLead[] = [];
  for (const row of rows) {
    const careersUrl = cellToString(row.cellValuesByColumnId[careersCol.id]);
    if (!careersUrl) continue;
    const companyName = companyCol ? cellToString(row.cellValuesByColumnId[companyCol.id]) : "";
    leads.push({
      company: companyName || hostnameOf(careersUrl),
      careersUrl,
      categories: [],
    });
  }

  return { leads };
}

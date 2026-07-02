import { createHash } from "node:crypto";
import { normalizeCareersUrl } from "@app/domain/normalize";

/**
 * Stable identifier for a company, derived from its normalized careers URL. Because
 * `normalizeCareersUrl` is deterministic, the same company yields the same id in the local SQLite
 * store and the hosted Postgres worker with no coordination — the same portability property that
 * makes `makePostingId` byte-identical across stores.
 */
export function makeCompanyId(careersUrl: string): string {
  return createHash("sha256").update(normalizeCareersUrl(careersUrl)).digest("hex").slice(0, 16);
}

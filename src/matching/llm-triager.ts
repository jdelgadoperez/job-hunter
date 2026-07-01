import type { SkillProfile, Warning } from "@app/domain/types";
import { errorMessage } from "@app/net/error-message";
import type { TriageClient } from "./triage-client";
import { buildTriagePrompt, type TriageItem } from "./triage-prompt";
import { TriagePayloadSchema } from "./triage-schema";
import { isUsageLimitError } from "./usage-limit-error";

const WARNING_SOURCE = "llm-triager";

/** Titles per triage LLM call. Shared by the CLI `score` command and the server score-runner. */
export const DEFAULT_TRIAGE_BATCH_SIZE = 40;

export type TriageResult = { keptIds: Set<string> };

/**
 * Batch keep/drop over job titles, backed by a `TriageClient`. Splits items into batches and
 * unions the kept ids. Fail-open: any batch that throws or returns a malformed / incomplete
 * payload keeps ALL of that batch's ids and emits a `Warning` — better to over-score a batch than
 * silently drop real matches. Exception: a provider usage-limit error is re-thrown so callers can
 * abort immediately rather than hammering a dead quota.
 */
export class LlmTriager {
  constructor(
    private readonly client: TriageClient,
    private readonly batchSize: number,
    private readonly onWarning?: (warning: Warning) => void,
  ) {}

  async triage(profile: SkillProfile, items: TriageItem[]): Promise<TriageResult> {
    const keptIds = new Set<string>();
    for (let start = 0; start < items.length; start += this.batchSize) {
      const batch = items.slice(start, start + this.batchSize);
      for (const id of await this.triageBatch(profile, batch)) keptIds.add(id);
    }
    return { keptIds };
  }

  /** Kept ids for a single batch; fail-opens (returns every id) on any error or incomplete result. */
  private async triageBatch(profile: SkillProfile, batch: TriageItem[]): Promise<string[]> {
    const batchIds = batch.map((item) => item.id);
    try {
      const payload = await this.client.triage(buildTriagePrompt(profile, batch));
      const parsed = TriagePayloadSchema.safeParse(payload);
      if (!parsed.success) return this.failOpen(batchIds, "triage returned a malformed payload");

      const decided = new Map(parsed.data.decisions.map((d) => [d.id, d.keep]));
      // Every id must have a decision; an incomplete batch is treated as a failure (fail-open).
      if (batchIds.some((id) => !decided.has(id))) {
        return this.failOpen(batchIds, "triage omitted some titles");
      }
      return batchIds.filter((id) => decided.get(id) === true);
    } catch (error) {
      if (isUsageLimitError(error)) throw error; // hard limit: propagate, do not fail-open
      return this.failOpen(batchIds, `triage failed: ${errorMessage(error)}`);
    }
  }

  private failOpen(batchIds: string[], message: string): string[] {
    this.onWarning?.({ source: WARNING_SOURCE, message: `${message}; keeping the batch` });
    return batchIds;
  }
}

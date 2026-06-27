import type { SkillProfile, Warning } from "@app/domain/types";
import { describe, expect, it } from "vitest";
import { LlmTriager } from "./llm-triager";
import { FakeTriageClient } from "./triage-client";
import type { TriageItem } from "./triage-prompt";

const profile: SkillProfile = { skills: ["ts"], roleKeywords: [], categories: [] };

function items(n: number): TriageItem[] {
  return Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, title: `Title ${i}` }));
}

describe("LlmTriager", () => {
  it("returns the union of kept ids across batches", async () => {
    const all = items(3);
    const client = new FakeTriageClient((request) => ({
      decisions: all
        .filter((item) => request.user.includes(item.id))
        .map((item) => ({ id: item.id, keep: item.id !== "id-1", reason: "x" })),
    }));
    const triager = new LlmTriager(client, 2);

    const result = await triager.triage(profile, all);

    expect(result.keptIds.has("id-0")).toBe(true);
    expect(result.keptIds.has("id-1")).toBe(false);
    expect(result.keptIds.has("id-2")).toBe(true);
  });

  it("fail-opens a throwing batch: keeps all its ids and warns", async () => {
    const all = items(2);
    const client = new FakeTriageClient(new Error("api down"));
    const warnings: Warning[] = [];
    const triager = new LlmTriager(client, 10, (w) => warnings.push(w));

    const result = await triager.triage(profile, all);

    for (const item of all) expect(result.keptIds.has(item.id)).toBe(true);
    expect(warnings.length).toBe(1);
  });

  it("propagates a usage-limit error instead of fail-opening it", async () => {
    const usageLimitError = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits."}}',
    );
    const client = new FakeTriageClient(usageLimitError);
    const warnings: Warning[] = [];
    const triager = new LlmTriager(client, 10, (w) => warnings.push(w));

    await expect(triager.triage(profile, items(2))).rejects.toThrow(usageLimitError.message);
    // Must NOT fail-open — no warning, no partial result.
    expect(warnings).toEqual([]);
  });

  it("fail-opens a batch whose payload omits some ids", async () => {
    const all = items(2);
    // Only decides the first id; the second is missing from the payload.
    const client = new FakeTriageClient({
      decisions: [{ id: "id-0", keep: false, reason: "drop" }],
    });
    const warnings: Warning[] = [];
    const triager = new LlmTriager(client, 10, (w) => warnings.push(w));

    const result = await triager.triage(profile, all);

    // Fail-open on an incomplete batch keeps every id in the batch.
    expect(result.keptIds.has("id-0")).toBe(true);
    expect(result.keptIds.has("id-1")).toBe(true);
    expect(warnings.length).toBe(1);
  });
});

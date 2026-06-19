import { describe, expect, it } from "vitest";
import { FakeLlmClient, type LlmScoreRequest } from "./llm-client";
import type { LlmMatchPayload } from "./llm-schema";

const payload: LlmMatchPayload = {
  score: 80,
  matchedSkills: ["typescript"],
  missingSkills: [],
  rationale: "ok",
};

const request: LlmScoreRequest = { system: "sys", user: "usr" };

describe("FakeLlmClient", () => {
  it("returns a canned payload for any request", async () => {
    const client = new FakeLlmClient(payload);
    await expect(client.score(request)).resolves.toEqual(payload);
  });

  it("supports a request-derived payload", async () => {
    const client = new FakeLlmClient((req) => ({ ...payload, rationale: req.user }));
    await expect(client.score(request)).resolves.toMatchObject({ rationale: "usr" });
  });

  it("rejects when configured with an error", async () => {
    const client = new FakeLlmClient(new Error("boom"));
    await expect(client.score(request)).rejects.toThrow("boom");
  });
});

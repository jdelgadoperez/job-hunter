import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicLlmClient, FakeLlmClient, type LlmScoreRequest } from "./llm-client";
import type { LlmMatchPayload } from "./llm-schema";

// Capture the Anthropic SDK surface the client touches, with no real network.
const sdk = vi.hoisted(() => ({
  parse: vi.fn(),
  constructorArgs: undefined as unknown,
}));

vi.mock("@anthropic-ai/sdk", () => ({
  Anthropic: class {
    messages = { parse: sdk.parse };
    constructor(opts: unknown) {
      sdk.constructorArgs = opts;
    }
  },
}));

vi.mock("@anthropic-ai/sdk/helpers/zod", () => ({
  zodOutputFormat: () => ({ marker: "zod-format" }),
}));

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

describe("AnthropicLlmClient", () => {
  beforeEach(() => {
    sdk.parse.mockReset();
    sdk.constructorArgs = undefined;
  });

  it("passes the api key to the SDK and maps a request onto the Messages API", async () => {
    sdk.parse.mockResolvedValue({ parsed_output: payload, stop_reason: "end_turn" });
    const client = new AnthropicLlmClient({ apiKey: "sk-test", model: "claude-x" });

    await expect(client.score(request)).resolves.toEqual(payload);

    expect(sdk.constructorArgs).toEqual({ apiKey: "sk-test" });
    // System carries the cacheable prefix; the volatile posting is the user turn.
    expect(sdk.parse).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-x",
        max_tokens: expect.any(Number),
        system: [expect.objectContaining({ text: "sys", cache_control: { type: "ephemeral" } })],
        messages: [{ role: "user", content: "usr" }],
      }),
    );
  });

  it("throws with the stop reason when the model returns no parseable output", async () => {
    sdk.parse.mockResolvedValue({ parsed_output: null, stop_reason: "max_tokens" });
    const client = new AnthropicLlmClient({ apiKey: "sk-test", model: "claude-x" });

    await expect(client.score(request)).rejects.toThrow(
      "LLM returned no parseable output (stop_reason: max_tokens)",
    );
  });
});

import { Anthropic } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { type LlmMatchPayload, MatchPayloadSchema } from "./llm-schema";
import { type LlmUsage, toLlmUsage } from "./llm-usage";

export type LlmScoreRequest = {
  /** Stable, cacheable prefix: scoring instructions + the serialized profile. */
  system: string;
  /** Volatile per-posting content: the job title + description. */
  user: string;
};

/**
 * The single LLM seam, mirroring the `Fetcher` pattern. Every unit that talks to a hosted
 * model takes an `LlmClient` so the automated suite runs against canned payloads with no
 * live network. `AnthropicLlmClient` is the production default (covered only by the opt-in
 * smoke script, like `HttpFetcher`); `FakeLlmClient` backs the tests.
 *
 * The interface is deliberately provider-agnostic — `{ system, user }` in, a validated
 * `LlmMatchPayload` out — so a second engine (OpenAI, Gemini, …) is a sibling class with
 * its own structured-output mechanics sealed inside it, not a refactor.
 */
export interface LlmClient {
  score(request: LlmScoreRequest): Promise<LlmMatchPayload>;
}

const MAX_TOKENS = 2048;

/** Production `LlmClient` backed by the Anthropic Messages API. Smoke-tested only. */
export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly onUsage?: (usage: LlmUsage) => void;

  constructor(opts: { apiKey: string; model: string; onUsage?: (usage: LlmUsage) => void }) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
    this.onUsage = opts.onUsage;
  }

  async score(request: LlmScoreRequest): Promise<LlmMatchPayload> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: MAX_TOKENS,
      thinking: { type: "disabled" },
      output_config: {
        effort: "low",
        format: zodOutputFormat(MatchPayloadSchema),
      },
      // Cacheable prefix: scoring rules + profile are byte-identical across every posting
      // in a run, so they go in a cached system block; the posting is the volatile user turn.
      system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: request.user }],
    });

    // Surface cache hit/miss so the caller can confirm the system prefix actually cached.
    this.onUsage?.(toLlmUsage(response.usage));

    if (response.parsed_output === null) {
      throw new Error(`LLM returned no parseable output (stop_reason: ${response.stop_reason})`);
    }
    return response.parsed_output;
  }
}

/**
 * Test double. Construct with a payload (or a function of the request) to drive the success
 * path, or with an `Error` to simulate an API failure / refusal. No network.
 */
export class FakeLlmClient implements LlmClient {
  constructor(
    private readonly response:
      | LlmMatchPayload
      | ((request: LlmScoreRequest) => LlmMatchPayload)
      | Error,
  ) {}

  async score(request: LlmScoreRequest): Promise<LlmMatchPayload> {
    if (this.response instanceof Error) {
      throw this.response;
    }
    return typeof this.response === "function" ? this.response(request) : this.response;
  }
}

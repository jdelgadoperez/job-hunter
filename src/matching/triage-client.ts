import { Anthropic } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { type LlmUsage, toLlmUsage } from "./llm-usage";
import type { LlmTriageRequest } from "./triage-prompt";
import { type LlmTriagePayload, TriagePayloadSchema } from "./triage-schema";

/**
 * The triage seam, mirroring `LlmClient`. Every unit that batch-triages titles takes a
 * `TriageClient` so the suite runs against canned payloads with no live network.
 * `AnthropicTriageClient` is the production default (smoke-only); `FakeTriageClient` backs tests.
 */
export interface TriageClient {
  triage(request: LlmTriageRequest): Promise<LlmTriagePayload>;
}

const MAX_TOKENS = 4096;

/** Production `TriageClient` backed by the Anthropic Messages API. Smoke-tested only. */
export class AnthropicTriageClient implements TriageClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly onUsage?: (usage: LlmUsage) => void;

  constructor(opts: { apiKey: string; model: string; onUsage?: (usage: LlmUsage) => void }) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
    this.onUsage = opts.onUsage;
  }

  async triage(request: LlmTriageRequest): Promise<LlmTriagePayload> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: MAX_TOKENS,
      thinking: { type: "disabled" },
      output_config: {
        effort: "low",
        format: zodOutputFormat(TriagePayloadSchema),
      },
      system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: request.user }],
    });

    // Surface cache hit/miss so the caller can confirm the system prefix actually cached.
    this.onUsage?.(toLlmUsage(response.usage));

    if (response.parsed_output === null) {
      throw new Error(`Triage returned no parseable output (stop_reason: ${response.stop_reason})`);
    }
    return response.parsed_output;
  }
}

/**
 * Test double. Construct with a payload (or a function of the request) to drive the success path,
 * or with an `Error` to simulate an API failure. No network.
 */
export class FakeTriageClient implements TriageClient {
  constructor(
    private readonly response:
      | LlmTriagePayload
      | ((request: LlmTriageRequest) => LlmTriagePayload)
      | Error,
  ) {}

  async triage(request: LlmTriageRequest): Promise<LlmTriagePayload> {
    if (this.response instanceof Error) throw this.response;
    return typeof this.response === "function" ? this.response(request) : this.response;
  }
}

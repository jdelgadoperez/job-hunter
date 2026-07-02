/**
 * Opt-in, manual Phase 0 probe for the beta **advisor tool** on the deep-score call. NOT part
 * of `npm test`.
 *
 *   ANTHROPIC_API_KEY=sk-... npm run smoke:advisor
 *
 * Answers the three questions from docs/advisor-tool-scoring-exploration.md before any
 * implementation, against the live API:
 *
 *   1. Does structured output compose with the advisor tool? We score with the REAL deep-score
 *      prompt and try to get back a schema-validated `LlmMatchPayload` from a request that also
 *      carries the advisor tool. Two variants, in order:
 *        (a) `beta.messages.parse` + `betaZodOutputFormat(MatchPayloadSchema)` → `parsed_output`
 *            (the beta-endpoint mirror of what `AnthropicLlmClient.score()` does today).
 *        (b) fallback: `beta.messages.create` + read the final text block + `safeParse`.
 *   2. Is the model pair accepted? Runs `claude-sonnet-5` + `claude-opus-4-8` (the target pair)
 *      and `claude-sonnet-4-6` + `claude-opus-4-8` (the fully-documented fallback). An invalid
 *      pair is a `400 invalid_request_error`.
 *   3. How is advisor usage reported? Prints the full `usage.iterations[]` so we can see the
 *      executor-vs-advisor token split (`type: "advisor_message"` entries are advisor spend and
 *      are NOT rolled into top-level `usage`).
 *
 * Spends a small amount of real budget (a few deep-score calls + advisor consults). Reads the key
 * from the environment; no key is ever committed. Exits cleanly with a message if no key is
 * present — never throws for a missing key. Per-variant API failures are caught and printed
 * verbatim so one bad pair/path doesn't hide the others.
 */
import { Anthropic } from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { JobPosting, SkillProfile } from "../src/domain/types";
import { type LlmMatchPayload, MatchPayloadSchema } from "../src/matching/llm-schema";
import { buildScorePrompt } from "../src/matching/score-prompt";

const ADVISOR_BETA = "advisor-tool-2026-03-01";
const MAX_TOKENS = 2048;

/** The advisor tool block for a given advisor model. */
function advisorTool(advisor: string) {
  return { type: "advisor_20260301" as const, name: "advisor", model: advisor };
}

/** The (executor, advisor) pairs to probe, target first, documented fallback second. */
const PAIRS: { executor: string; advisor: string }[] = [
  { executor: "claude-sonnet-5", advisor: "claude-opus-4-8" },
  { executor: "claude-sonnet-4-6", advisor: "claude-opus-4-8" },
];

const profile: SkillProfile = {
  skills: ["typescript", "react", "node.js", "postgresql", "aws"],
  roleKeywords: ["frontend engineer", "full stack"],
  categories: ["Engineering"],
  yearsExperience: 8,
};

const posting: JobPosting = {
  id: "advisor-smoke-1",
  company: "Example Co",
  title: "Senior Full Stack Engineer",
  url: "https://example.com/jobs/advisor-smoke-1",
  source: "smoke",
  description:
    "We're hiring a senior full stack engineer to build our web platform. " +
    "Strong TypeScript and React required; experience with Node.js and a relational " +
    "database expected. Bonus: Kubernetes and Go. You'll own features end to end.",
  fetchedAt: new Date(),
};

/** Reproduce `AnthropicLlmClient.score()`'s system/user shaping (cache_control on the prefix). */
function scoreInputs() {
  const request = buildScorePrompt(profile, posting);
  return {
    system: [
      {
        type: "text" as const,
        text: request.system,
        cache_control: { type: "ephemeral" as const },
      },
    ],
    messages: [{ role: "user" as const, content: request.user }],
  };
}

/** Print the executor/advisor token split from `usage.iterations[]`, plus the raw usage object. */
function printUsage(usage: unknown): void {
  console.log("  usage (raw):", JSON.stringify(usage, null, 2));
  if (usage && typeof usage === "object" && "iterations" in usage) {
    const iterations = (usage as { iterations?: { type?: string; output_tokens?: number }[] })
      .iterations;
    if (Array.isArray(iterations)) {
      const advisorOut = iterations
        .filter((it) => it.type === "advisor_message")
        .reduce((sum, it) => sum + (it.output_tokens ?? 0), 0);
      const executorOut = iterations
        .filter((it) => it.type === "message")
        .reduce((sum, it) => sum + (it.output_tokens ?? 0), 0);
      console.log(
        `  → executor output tokens: ${executorOut}; advisor output tokens: ${advisorOut}`,
      );
    }
  }
}

function logPayload(payload: LlmMatchPayload): void {
  console.log(
    `  score=${payload.score} matched=[${payload.matchedSkills.join(", ")}] missing=[${payload.missingSkills.join(", ")}]`,
  );
  console.log(`  rationale: ${payload.rationale}`);
}

/** Variant (a): the structured-output path — beta.messages.parse + betaZodOutputFormat. */
async function tryParsePath(client: Anthropic, executor: string, advisor: string): Promise<void> {
  console.log("  [variant a] beta.messages.parse + betaZodOutputFormat …");
  const { system, messages } = scoreInputs();
  const response = await client.beta.messages.parse({
    model: executor,
    max_tokens: MAX_TOKENS,
    betas: [ADVISOR_BETA],
    thinking: { type: "disabled" },
    output_config: { effort: "low", format: betaZodOutputFormat(MatchPayloadSchema) },
    tools: [advisorTool(advisor)],
    system,
    messages,
  });
  if (response.parsed_output === null) {
    console.log(`  ✗ parsed_output was null (stop_reason: ${response.stop_reason})`);
  } else {
    console.log("  ✓ structured output composes on the beta endpoint (parsed_output present)");
    logPayload(response.parsed_output);
  }
  printUsage(response.usage);
}

/** Variant (b): fallback — beta.messages.create, read the final text block, safeParse it. */
async function tryCreatePath(client: Anthropic, executor: string, advisor: string): Promise<void> {
  console.log("  [variant b] beta.messages.create + manual safeParse …");
  const { system, messages } = scoreInputs();
  const response = await client.beta.messages.create({
    model: executor,
    max_tokens: MAX_TOKENS,
    betas: [ADVISOR_BETA],
    thinking: { type: "disabled" },
    tools: [advisorTool(advisor)],
    system,
    messages,
  });
  const text = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    console.log(
      `  ✗ final text block is not clean JSON (needs a JSON-only instruction). Raw text:\n${text}`,
    );
    printUsage(response.usage);
    return;
  }
  const result = MatchPayloadSchema.safeParse(parsedJson);
  if (result.success) {
    console.log("  ✓ manual safeParse of the text block succeeded");
    logPayload(result.data);
  } else {
    console.log(`  ✗ safeParse failed: ${result.error.message}`);
  }
  printUsage(response.usage);
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set — skipping live advisor-tool probe.");
    process.exitCode = 1;
    return;
  }

  const client = new Anthropic({ apiKey });

  for (const { executor, advisor } of PAIRS) {
    console.log(`\n=== executor=${executor}  advisor=${advisor} ===`);
    try {
      await tryParsePath(client, executor, advisor);
    } catch (error) {
      console.log("  [variant a] failed:", error instanceof Error ? error.message : String(error));
      try {
        await tryCreatePath(client, executor, advisor);
      } catch (createError) {
        console.log(
          "  [variant b] also failed:",
          createError instanceof Error ? createError.message : String(createError),
        );
      }
    }
  }

  console.log(
    "\nDone. Record the answers (which variant worked, the token split, any 400) back into " +
      "docs/advisor-tool-scoring-exploration.md so Phase 1 starts from facts.",
  );
}

main().catch((error) => {
  console.error("Advisor probe failed:", error);
  process.exitCode = 1;
});

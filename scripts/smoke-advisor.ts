/**
 * Opt-in, manual Phase 0 probe for the beta **advisor tool** on the deep-score call. NOT part
 * of `npm test`.
 *
 *   ANTHROPIC_API_KEY=sk-... npm run smoke:advisor
 *
 * Answers the questions from docs/advisor-tool-scoring-exploration.md against the live API:
 *
 *   1. Does structured output compose with the advisor tool? We score with the REAL deep-score
 *      prompt and try to get back a schema-validated `LlmMatchPayload` from a request that also
 *      carries the advisor tool. Two variants:
 *        (a) `beta.messages.parse` + `betaZodOutputFormat(MatchPayloadSchema)` → `parsed_output`
 *            (the beta-endpoint mirror of what `AnthropicLlmClient.score()` does today).
 *        (b) fallback: `beta.messages.create` + read the final text block + `safeParse`.
 *   2. Is the model pair accepted? Runs `claude-sonnet-5` + `claude-opus-4-8` (the target pair)
 *      and `claude-sonnet-4-6` + `claude-opus-4-8` (the fully-documented fallback). An invalid
 *      pair is a `400 invalid_request_error`.
 *   3. How is advisor usage reported? Prints the full `usage.iterations[]` so we can see the
 *      executor-vs-advisor token split (`type: "advisor_message"` entries are advisor spend and
 *      are NOT rolled into top-level `usage`).
 *   4. **THE RE-PROBE QUESTION:** available-not-forced — does the agent consult the advisor ON ITS
 *      OWN when the score is a genuine judgment call? Runs two scenarios UNFORCED: an easy/obvious
 *      match (expected: no self-consult) and a HARD, ambiguous match with a prompt that explicitly
 *      permits (not forces) consulting. Each unforced run prints '★ AGENT SELF-CONSULTED' or
 *      '○ did NOT consult'. The easy scenario also runs forced once per pair to re-confirm the
 *      forced-mode pause_turn / runaway-cost failure.
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

/**
 * A scored scenario: a profile + posting, plus whether the fit is an easy call or a genuine
 * judgment call. The "hard" scenario is the fair test of whether the agent will consult the
 * advisor ON ITS OWN when the score is ambiguous (vs. the easy case, where it clearly won't).
 */
type Scenario = {
  label: string;
  profile: SkillProfile;
  posting: JobPosting;
  invitePlanning: boolean;
};

/** Easy case: a frontend candidate against a frontend role — an obvious high match, nothing to plan. */
const easyScenario: Scenario = {
  label: "easy (obvious match)",
  invitePlanning: false,
  profile: {
    skills: ["typescript", "react", "node.js", "postgresql", "aws"],
    roleKeywords: ["frontend engineer", "full stack"],
    categories: ["Engineering"],
    yearsExperience: 8,
  },
  posting: {
    id: "advisor-smoke-easy",
    company: "Example Co",
    title: "Senior Full Stack Engineer",
    url: "https://example.com/jobs/advisor-smoke-easy",
    source: "smoke",
    description:
      "We're hiring a senior full stack engineer to build our web platform. " +
      "Strong TypeScript and React required; experience with Node.js and a relational " +
      "database expected. Bonus: Kubernetes and Go. You'll own features end to end.",
    fetchedAt: new Date(),
  },
};

/**
 * Hard case: a backend/data-engineering candidate against a senior FRONTEND role. The match hinges
 * on a transferable-skills judgment (does deep backend + some JS transfer to a design-systems-heavy
 * frontend lead?) — genuinely debatable, the kind of call where a model might want a second opinion.
 * `invitePlanning` also swaps in a scoring instruction that explicitly PERMITS (not forces) an
 * advisor consult for borderline calls, removing the "return only the structured fields" nudge that
 * discourages any deliberation step.
 */
const hardScenario: Scenario = {
  label: "hard (ambiguous, planning invited)",
  invitePlanning: true,
  profile: {
    skills: [
      "python",
      "django",
      "data pipelines",
      "airflow",
      "postgresql",
      "spark",
      "some javascript",
    ],
    roleKeywords: ["backend engineer", "data engineer", "platform"],
    categories: ["Engineering", "Data"],
    yearsExperience: 8,
  },
  posting: {
    id: "advisor-smoke-hard",
    company: "Example Co",
    title: "Senior Frontend Engineer (Design Systems)",
    url: "https://example.com/jobs/advisor-smoke-hard",
    source: "smoke",
    description:
      "Senior frontend engineer to lead our design system: deep React + TypeScript, " +
      "component-library architecture, accessibility, and pixel-level polish. You'll set frontend " +
      "direction across teams. We value strong engineering fundamentals and are open to candidates " +
      "growing into the frontend depth — but this is a frontend leadership role, not a generalist one.",
    fetchedAt: new Date(),
  },
};

const SCENARIOS: Scenario[] = [easyScenario, hardScenario];

/**
 * A scoring instruction that PERMITS (does not force) an advisor consult on hard calls. Mirrors the
 * production instruction's schema contract, but drops the "return only the structured fields" nudge
 * and explicitly tells the model it may deliberate/consult before committing to a borderline score.
 */
const PLANNING_INVITED_NOTE =
  "\n\nThis match is a judgment call. If the fit between the candidate and the role is genuinely " +
  "ambiguous — e.g. the candidate's background is adjacent rather than a direct match — you may " +
  "think it through or consult an available advisor before committing to a score. Then return the " +
  "structured fields.";

/** Reproduce `AnthropicLlmClient.score()`'s system/user shaping (cache_control on the prefix). */
function scoreInputs(scenario: Scenario) {
  const request = buildScorePrompt(scenario.profile, scenario.posting);
  const systemText = scenario.invitePlanning
    ? request.system + PLANNING_INVITED_NOTE
    : request.system;
  return {
    system: [
      {
        type: "text" as const,
        text: systemText,
        cache_control: { type: "ephemeral" as const },
      },
    ],
    messages: [{ role: "user" as const, content: request.user }],
  };
}

/**
 * Print the executor/advisor token split from `usage.iterations[]`, plus the raw usage object.
 * Returns the number of `advisor_message` iterations so the caller can state plainly whether the
 * agent consulted the advisor (the whole question of the unforced re-probe).
 */
function printUsage(usage: unknown): { advisorConsults: number; advisorOut: number } {
  console.log("  usage (raw):", JSON.stringify(usage, null, 2));
  if (usage && typeof usage === "object" && "iterations" in usage) {
    const iterations = (usage as { iterations?: { type?: string; output_tokens?: number }[] })
      .iterations;
    if (Array.isArray(iterations)) {
      const advisorIterations = iterations.filter((it) => it.type === "advisor_message");
      const advisorOut = advisorIterations.reduce((sum, it) => sum + (it.output_tokens ?? 0), 0);
      const executorOut = iterations
        .filter((it) => it.type === "message")
        .reduce((sum, it) => sum + (it.output_tokens ?? 0), 0);
      console.log(
        `  → executor output tokens: ${executorOut}; advisor output tokens: ${advisorOut}; advisor consults: ${advisorIterations.length}`,
      );
      return { advisorConsults: advisorIterations.length, advisorOut };
    }
  }
  return { advisorConsults: 0, advisorOut: 0 };
}

function logPayload(payload: LlmMatchPayload): void {
  console.log(
    `  score=${payload.score} matched=[${payload.matchedSkills.join(", ")}] missing=[${payload.missingSkills.join(", ")}]`,
  );
  console.log(`  rationale: ${payload.rationale}`);
}

/**
 * Variant (a): the structured-output path — beta.messages.parse + betaZodOutputFormat.
 *
 * When `forceAdvisor` is set, adds `tool_choice: { type: "tool", name: "advisor" }` to force the
 * consult. Without it, a single-turn score has "nothing to plan" and the executor typically skips
 * the advisor entirely (advisor tokens: 0) — so the forced run is the one that actually exercises
 * the Opus advisor and yields a real `advisor_message` token split. Forcing tool use cannot combine
 * with extended thinking (the API 400s), so `thinking` stays disabled — which the scorer already does.
 */
async function tryParsePath(
  client: Anthropic,
  executor: string,
  advisor: string,
  scenario: Scenario,
  forceAdvisor: boolean,
): Promise<void> {
  console.log(
    `  [variant a${forceAdvisor ? " · forced advisor" : ""}] beta.messages.parse + betaZodOutputFormat …`,
  );
  const { system, messages } = scoreInputs(scenario);
  const response = await client.beta.messages.parse({
    model: executor,
    max_tokens: MAX_TOKENS,
    betas: [ADVISOR_BETA],
    thinking: { type: "disabled" },
    output_config: { effort: "low", format: betaZodOutputFormat(MatchPayloadSchema) },
    tools: [advisorTool(advisor)],
    ...(forceAdvisor ? { tool_choice: { type: "tool" as const, name: "advisor" } } : {}),
    system,
    messages,
  });
  if (response.parsed_output === null) {
    console.log(`  ✗ parsed_output was null (stop_reason: ${response.stop_reason})`);
  } else {
    console.log("  ✓ structured output composes on the beta endpoint (parsed_output present)");
    logPayload(response.parsed_output);
  }
  const { advisorConsults } = printUsage(response.usage);
  if (!forceAdvisor) {
    console.log(
      advisorConsults > 0
        ? `  ★ AGENT SELF-CONSULTED the advisor ${advisorConsults}× on this scenario (available-not-forced has value here)`
        : "  ○ agent did NOT consult the advisor on its own (available-not-forced is inert here)",
    );
  }
}

/** Variant (b): fallback — beta.messages.create, read the final text block, safeParse it. */
async function tryCreatePath(
  client: Anthropic,
  executor: string,
  advisor: string,
  scenario: Scenario,
): Promise<void> {
  console.log("  [variant b] beta.messages.create + manual safeParse …");
  const { system, messages } = scoreInputs(scenario);
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

  // The re-probe's real question: does the agent CONSULT THE ADVISOR ON ITS OWN (unforced) when the
  // score is a genuine judgment call? So the unforced path runs for every scenario × pair. The
  // easy scenario also runs forced once (per pair) to re-confirm the pause_turn / runaway-cost
  // finding without re-spending it on every scenario.
  for (const scenario of SCENARIOS) {
    for (const { executor, advisor } of PAIRS) {
      console.log(`\n=== [${scenario.label}] executor=${executor}  advisor=${advisor} ===`);
      const forceModes = scenario.invitePlanning ? [false] : [false, true];
      for (const forceAdvisor of forceModes) {
        try {
          await tryParsePath(client, executor, advisor, scenario, forceAdvisor);
        } catch (error) {
          console.log(
            `  [variant a${forceAdvisor ? " · forced advisor" : ""}] failed:`,
            error instanceof Error ? error.message : String(error),
          );
          // Only probe the manual-parse fallback on the unforced path; if forcing is what broke,
          // the failure itself is the finding, not a parse-mechanism question.
          if (!forceAdvisor) {
            try {
              await tryCreatePath(client, executor, advisor, scenario);
            } catch (createError) {
              console.log(
                "  [variant b] also failed:",
                createError instanceof Error ? createError.message : String(createError),
              );
            }
          }
        }
      }
    }
  }

  console.log(
    "\nDone. Key question: did any UNFORCED [hard] run show '★ AGENT SELF-CONSULTED'? If yes, " +
      "available-not-forced has value on ambiguous scores; if every hard run shows '○ did NOT " +
      "consult', the tool is inert for this workload. Record the answer in " +
      "docs/advisor-tool-scoring-exploration.md.",
  );
}

main().catch((error) => {
  console.error("Advisor probe failed:", error);
  process.exitCode = 1;
});

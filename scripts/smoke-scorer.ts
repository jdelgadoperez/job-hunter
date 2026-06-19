/**
 * Opt-in, manual smoke test for the live LLM scorer. NOT part of `npm test`.
 *
 *   ANTHROPIC_API_KEY=sk-... npm run smoke:scorer
 *
 * Scores a sample profile against a sample posting using the real `AnthropicLlmClient`
 * (the only place the live SDK path runs), printing the `MatchResult` and any warnings.
 * Verifies the prompt + structured-output contract still holds against the real API when
 * run intentionally. Exits cleanly with a message if no key is present — never throws.
 *
 * No key is ever committed; the key is read from the environment.
 */
import type { JobPosting, SkillProfile, Warning } from "../src/domain/types";
import { HeuristicScorer } from "../src/matching/heuristic-scorer";
import { AnthropicLlmClient } from "../src/matching/llm-client";
import { LlmScorer } from "../src/matching/llm-scorer";

const profile: SkillProfile = {
  skills: ["typescript", "react", "node.js", "postgresql", "aws"],
  roleKeywords: ["frontend engineer", "full stack"],
  categories: ["Engineering"],
  yearsExperience: 8,
};

const posting: JobPosting = {
  id: "smoke-1",
  company: "Example Co",
  title: "Senior Full Stack Engineer",
  url: "https://example.com/jobs/smoke-1",
  source: "smoke",
  description:
    "We're hiring a senior full stack engineer to build our web platform. " +
    "Strong TypeScript and React required; experience with Node.js and a relational " +
    "database expected. Bonus: Kubernetes and Go. You'll own features end to end.",
  fetchedAt: new Date(),
};

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set — skipping live scorer smoke test.");
    process.exitCode = 1;
    return;
  }

  const model = process.env.SCORER_MODEL?.trim() || "claude-sonnet-4-6";
  const warnings: Warning[] = [];
  const scorer = new LlmScorer(
    new AnthropicLlmClient({ apiKey, model }),
    new HeuristicScorer(),
    (w) => warnings.push(w),
  );

  console.log(`Scoring with model: ${model}\n`);
  const result = await scorer.score(profile, posting);
  console.log(JSON.stringify(result, null, 2));

  if (warnings.length > 0) {
    console.log("\nWarnings:");
    for (const w of warnings) {
      console.log(`  [${w.source}] ${w.message}`);
    }
  }
}

main().catch((error) => {
  console.error("Smoke test failed:", error);
  process.exitCode = 1;
});

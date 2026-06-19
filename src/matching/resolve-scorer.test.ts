import type { JobPosting, SkillProfile, Warning } from "@app/domain/types";
import { describe, expect, it } from "vitest";
import { HeuristicScorer } from "./heuristic-scorer";
import { FakeLlmClient } from "./llm-client";
import { LlmScorer } from "./llm-scorer";
import { resolveScorer } from "./resolve-scorer";
import { MODEL_SETTING, PROVIDER_SETTING, type SettingsReader } from "./resolve-settings";

function reader(values: Record<string, string>): SettingsReader {
  return { getSetting: (key) => values[key] };
}

const profile: SkillProfile = {
  skills: ["typescript"],
  roleKeywords: ["frontend engineer"],
  categories: [],
};

const posting: JobPosting = {
  id: "1",
  company: "Acme",
  title: "Frontend Engineer",
  url: "https://example.com/1",
  source: "test",
  description: "TypeScript role.",
  fetchedAt: new Date(0),
};

describe("resolveScorer", () => {
  it("returns a HeuristicScorer and warns once when no key is configured", () => {
    const warnings: Warning[] = [];
    const scorer = resolveScorer({ settings: reader({}), onWarning: (w) => warnings.push(w) });
    expect(scorer).toBeInstanceOf(HeuristicScorer);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("anthropic");
  });

  it("returns an LlmScorer wired to the injected client when a key is present", async () => {
    let received: { apiKey: string; model: string } | undefined;
    const scorer = resolveScorer({
      settings: reader({ anthropicApiKey: "sk-1", [MODEL_SETTING]: "claude-opus-4-8" }),
      clientOverride: (_provider, opts) => {
        received = opts;
        return new FakeLlmClient({
          score: 90,
          matchedSkills: ["typescript"],
          missingSkills: [],
          rationale: "from the fake client",
        });
      },
    });
    expect(scorer).toBeInstanceOf(LlmScorer);

    const result = await scorer.score(profile, posting);
    expect(result.rationale).toBe("from the fake client");
    // The resolved model (the scorerModel setting) reaches the client factory.
    expect(received?.model).toBe("claude-opus-4-8");
    expect(received?.apiKey).toBe("sk-1");
  });

  it("treats an unknown provider as anthropic rather than erroring", () => {
    const scorer = resolveScorer({ settings: reader({ [PROVIDER_SETTING]: "openai" }) });
    expect(scorer).toBeInstanceOf(HeuristicScorer);
  });
});

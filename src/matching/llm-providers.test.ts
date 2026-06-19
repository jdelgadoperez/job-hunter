import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER, LLM_PROVIDERS } from "./llm-providers";

describe("LLM_PROVIDERS registry", () => {
  it("DEFAULT_PROVIDER is a valid registry key", () => {
    expect(LLM_PROVIDERS[DEFAULT_PROVIDER]).toBeDefined();
  });

  it("every entry is well-formed and self-consistent", () => {
    for (const [key, config] of Object.entries(LLM_PROVIDERS)) {
      expect(config.id).toBe(key);
      expect(config.apiKeySetting.length).toBeGreaterThan(0);
      expect(config.defaultModel.length).toBeGreaterThan(0);
      expect(typeof config.createClient).toBe("function");
    }
  });
});

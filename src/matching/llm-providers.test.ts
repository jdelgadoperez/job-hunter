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
      // The picker lists the default first, and every option is distinct and described.
      expect(config.models[0]?.id).toBe(config.defaultModel);
      expect(new Set(config.models.map((m) => m.id)).size).toBe(config.models.length);
      for (const model of config.models) {
        expect(model.label.length).toBeGreaterThan(0);
        expect(model.note.length).toBeGreaterThan(0);
      }
    }
  });
});

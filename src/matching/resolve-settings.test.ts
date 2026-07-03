import { Repository } from "@app/storage/repository";
import { describe, expect, it } from "vitest";
import {
  MODEL_SETTING,
  PROVIDER_SETTING,
  resolveApiKey,
  resolveHomeCountry,
  resolveProvider,
  resolveScorerModel,
  type SettingsReader,
} from "./resolve-settings";
import { HOME_COUNTRY_SETTING } from "./settings-keys";

function reader(values: Record<string, string>): SettingsReader {
  return { getSetting: (key) => values[key] };
}

describe("resolveProvider", () => {
  it("falls back to anthropic when unset", () => {
    expect(resolveProvider(reader({})).id).toBe("anthropic");
  });

  it("falls back to anthropic for a blank or unknown id", () => {
    expect(resolveProvider(reader({ [PROVIDER_SETTING]: "   " })).id).toBe("anthropic");
    expect(resolveProvider(reader({ [PROVIDER_SETTING]: "openai" })).id).toBe("anthropic");
  });

  it("returns the matching config for a known id", () => {
    expect(resolveProvider(reader({ [PROVIDER_SETTING]: "anthropic" })).id).toBe("anthropic");
  });
});

describe("resolveApiKey", () => {
  const provider = resolveProvider(reader({}));

  it("returns the trimmed key when present", () => {
    expect(resolveApiKey(reader({ [provider.apiKeySetting]: "  sk-123  " }), provider)).toBe(
      "sk-123",
    );
  });

  it("returns undefined when absent or whitespace-only", () => {
    expect(resolveApiKey(reader({}), provider)).toBeUndefined();
    expect(resolveApiKey(reader({ [provider.apiKeySetting]: "   " }), provider)).toBeUndefined();
  });
});

describe("resolveScorerModel", () => {
  const provider = resolveProvider(reader({}));

  it("returns the configured model when set", () => {
    expect(resolveScorerModel(reader({ [MODEL_SETTING]: "claude-opus-4-8" }), provider)).toBe(
      "claude-opus-4-8",
    );
  });

  it("returns the provider default when unset", () => {
    expect(resolveScorerModel(reader({}), provider)).toBe(provider.defaultModel);
  });
});

describe("resolveHomeCountry", () => {
  it("returns undefined when unset", () => {
    expect(resolveHomeCountry(reader({}))).toBeUndefined();
  });

  it("returns the trimmed stored value", () => {
    expect(resolveHomeCountry(reader({ [HOME_COUNTRY_SETTING]: " US " }))).toBe("US");
  });

  it("returns undefined for a blank value", () => {
    expect(resolveHomeCountry(reader({ [HOME_COUNTRY_SETTING]: "   " }))).toBeUndefined();
  });

  it("canonicalizes a free-text country name to the label postings resolve to", () => {
    expect(resolveHomeCountry(reader({ [HOME_COUNTRY_SETTING]: "United States" }))).toBe("US");
    expect(resolveHomeCountry(reader({ [HOME_COUNTRY_SETTING]: "usa" }))).toBe("US");
    expect(resolveHomeCountry(reader({ [HOME_COUNTRY_SETTING]: "united kingdom" }))).toBe("UK");
  });

  it("falls back to the trimmed raw value when the country can't be canonicalized", () => {
    expect(resolveHomeCountry(reader({ [HOME_COUNTRY_SETTING]: " Freedonia " }))).toBe("Freedonia");
  });
});

describe("settings table wiring", () => {
  it("round-trips through a real Repository", () => {
    const repo = new Repository(":memory:");
    repo.setSetting("anthropicApiKey", "sk-live");
    repo.setSetting(MODEL_SETTING, "claude-opus-4-8");
    const provider = resolveProvider(repo);
    expect(resolveApiKey(repo, provider)).toBe("sk-live");
    expect(resolveScorerModel(repo, provider)).toBe("claude-opus-4-8");
    repo.close();
  });
});

import { describe, expect, it } from "vitest";
import { noThinkingFor, noThinkingParam } from "./thinking-config";

describe("noThinkingFor", () => {
  it("uses between_tools on Claude Sonnet 5.5, which rejects disabled", () => {
    expect(noThinkingFor("claude-sonnet-5-5")).toEqual({ type: "between_tools" });
    expect(noThinkingFor(" Claude-Sonnet-5-5 ")).toEqual({ type: "between_tools" });
  });

  it("omits thinking on models that can't turn it off", () => {
    expect(noThinkingFor("claude-opus-5-5")).toBeUndefined();
    expect(noThinkingFor("claude-fable-5-2")).toBeUndefined();
    expect(noThinkingFor("claude-mythos-5-2")).toBeUndefined();
  });

  it("disables thinking on every other model", () => {
    expect(noThinkingFor("claude-sonnet-5")).toEqual({ type: "disabled" });
    expect(noThinkingFor("claude-opus-4-8")).toEqual({ type: "disabled" });
    expect(noThinkingFor("claude-haiku-5-5")).toEqual({ type: "disabled" });
  });
});

describe("noThinkingParam", () => {
  it("spreads the setting, or nothing when thinking must be omitted", () => {
    expect(noThinkingParam("claude-sonnet-5-5")).toEqual({ thinking: { type: "between_tools" } });
    expect(noThinkingParam("claude-opus-5-5")).toEqual({});
  });
});

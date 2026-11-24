import type { Anthropic } from "@anthropic-ai/sdk";

/**
 * The `thinking` setting for job-hunter's cheap, structured-output scoring calls, which want no
 * extended thinking. How to say "no thinking" differs by model:
 *
 * - Claude Sonnet 5.5 rejects `{ type: "disabled" }` with a 400; its thinking-off setting is
 *   `{ type: "between_tools" }` (valid at effort `high` or below — we send `low`). No other model
 *   accepts `between_tools`.
 * - Claude Opus 5.5 and the Fable / Mythos models can't turn thinking off at all; `disabled` is a
 *   400. We omit the field there, so they run adaptive thinking at the request's `low` effort.
 * - Every other model takes `{ type: "disabled" }`, as before.
 *
 * The model is user-configurable (the `scorerModel` setting), so this has to follow it rather
 * than hard-code the default's setting. Returns `undefined` when the field should be omitted.
 */
export function noThinkingFor(model: string): Anthropic.ThinkingConfigParam | undefined {
  const id = model.trim().toLowerCase();
  if (id === "claude-sonnet-5-5" || id.startsWith("claude-sonnet-5-5-")) {
    // The pinned SDK (0.112.x) predates `between_tools`; the API accepts it, so widen the type.
    return { type: "between_tools" } as unknown as Anthropic.ThinkingConfigParam;
  }
  if (
    id === "claude-opus-5-5" ||
    id.startsWith("claude-opus-5-5-") ||
    id.startsWith("claude-fable-") ||
    id.startsWith("claude-mythos-")
  ) {
    return undefined;
  }
  return { type: "disabled" };
}

/** Spread into a request: `{ thinking }` for `model`, or nothing when it must be omitted. */
export function noThinkingParam(model: string): { thinking?: Anthropic.ThinkingConfigParam } {
  const thinking = noThinkingFor(model);
  return thinking ? { thinking } : {};
}

# Handoff: advisor-tool Phase 0 smoke probe

> **For local work.** This is a self-contained spec to build and run the Phase 0 probe from
> [`docs/advisor-tool-scoring-exploration.md`](advisor-tool-scoring-exploration.md). It runs against
> the **live Anthropic API** (needs a real `ANTHROPIC_API_KEY`), so it can't run in CI or the cloud
> sandbox — do it on your machine. It's an **opt-in smoke script**, like `smoke:scorer` — excluded
> from the unit suite and the coverage gate.

## Goal

Answer the one open question before we build anything real: **does the beta advisor tool compose with
our structured-output deep-score call, and what does it cost?** Concretely, resolve:

1. **Structured output composes.** Our scorer uses `messages.parse()` + `output_config.format` (a zod
   schema → validated `LlmMatchPayload`). Confirm we can get the same validated payload back from a
   request that *also* carries the advisor tool. The likely path is `client.beta.messages.create`
   with `betas: ["advisor-tool-2026-03-01"]`; verify whether `output_config` is accepted there and
   whether a parse helper exists, or whether we must validate manually with `MatchPayloadSchema.safeParse`.
2. **The model pair is accepted.** `claude-sonnet-5` executor + `claude-opus-4-8` advisor should be
   valid per the docs — confirm no `400 invalid_request_error`. Also try `claude-sonnet-4-6` +
   `claude-opus-4-8` as the fully-documented fallback pair.
3. **Usage accounting.** Confirm advisor tokens show up in `usage.iterations[]` (entries with
   `type: "advisor_message"`) and are **not** in the top-level `usage`. This dictates the
   `UsageAccumulator` change in Phase 1.

## What to build

`scripts/smoke-advisor.ts`, wired as an npm script `"smoke:advisor": "node --import tsx scripts/smoke-advisor.ts"`
(mirror the existing `smoke:scorer` entry in `package.json`).

### Reference: the exact API shape (from the live docs)

Beta header/flag: **`advisor-tool-2026-03-01`**. Tool block:

```jsonc
{ "type": "advisor_20260301", "name": "advisor", "model": "claude-opus-4-8" }
```

TypeScript call (from the docs' Quick start):

```ts
import { Anthropic } from "@anthropic-ai/sdk";
const client = new Anthropic(); // reads ANTHROPIC_API_KEY

const response = await client.beta.messages.create({
  model: "claude-sonnet-5",                 // executor
  max_tokens: 2048,
  betas: ["advisor-tool-2026-03-01"],
  tools: [{ type: "advisor_20260301", name: "advisor", model: "claude-opus-4-8" }],
  messages: [{ role: "user", content: "…" }],
});
```

### The real test: fold in our actual scoring inputs

Don't test with the docs' toy prompt — use the **real deep-score prompt** so the result transfers:

- Import `buildScorePrompt` from `src/matching/score-prompt.ts` and build a `{ system, user }` from a
  hand-written `SkillProfile` + a sample `JobPosting` (any realistic posting text).
- Put `request.system` in the `system` block (keep the `cache_control: { type: "ephemeral" }` marker
  we use today) and `request.user` as the user message — i.e. reproduce `AnthropicLlmClient.score()`
  exactly, then add the advisor tool.
- Import `MatchPayloadSchema` from `src/matching/llm-schema.ts` to validate whatever comes back.

### Try, in order, and record the outcome of each

1. **Structured output via `output_config` on the beta endpoint.** Add
   `output_config: { effort: "low", format: zodOutputFormat(MatchPayloadSchema) }` to the
   `beta.messages.create` call (as our non-advisor path does). Does it 400? If accepted, is there a
   `parsed_output`, or do you parse the text block yourself?
2. **If `output_config` isn't supported on `beta.messages.create`:** drop it, read the final text
   content block, and `MatchPayloadSchema.safeParse(JSON.parse(text))`. Note whether the model
   reliably returns clean JSON without the structured-output constraint (may need a "respond only with
   JSON matching this schema" instruction in the system prompt).
3. **Model pairs:** run once with `claude-sonnet-5` + `claude-opus-4-8`, once with
   `claude-sonnet-4-6` + `claude-opus-4-8`. Record any `400` and its message.

### What to print

- Whether each variant succeeded, and the validated `LlmMatchPayload` (score/matched/missing/rationale).
- The **full `usage` object including `usage.iterations[]`** — so we can see executor vs. advisor
  token split. Sum the `advisor_message` iterations to get advisor spend; compare to top-level
  `usage.output_tokens` (executor only).
- Any error body verbatim on failure.

## Env & running

```bash
export ANTHROPIC_API_KEY=sk-ant-...      # a key with advisor-tool beta access
npm run smoke:advisor
```

Notes:
- No DB needed — this doesn't touch SQLite, so the `better-sqlite3` build issue is irrelevant.
- This spends a small amount of real budget (one or two deep-score calls + advisor consults). Keep
  `max_tokens` modest (2048, as the scorer uses).
- Keep it out of CI/coverage: `smoke:*` scripts already are (see `vitest.config.ts` excludes and the
  CLAUDE.md note on opt-in smoke scripts).

## Acceptance criteria (what "Phase 0 done" means)

- [ ] `claude-sonnet-5` + `claude-opus-4-8` returns a valid, schema-passing `LlmMatchPayload` (or the
      exact error if not).
- [ ] We know whether structured output uses `output_config` on the beta endpoint or needs manual
      `safeParse` (records which).
- [ ] We've seen `usage.iterations[]` and know how to sum advisor vs. executor tokens.
- [ ] A one-paragraph note added back to `advisor-tool-scoring-exploration.md` recording the answers,
      so Phase 1 (prototype behind a setting) can start from facts.

## Then → Phase 1 (separate work)

With the above answered: add `scorerAdvisorModel` (+ on/off) to settings/`llm-providers.ts`, branch
`AnthropicLlmClient.score()` to the advisor path when set (off by default), and extend
`UsageAccumulator` to sum `usage.iterations[]`. Measure quality-per-dollar vs. current Sonnet and vs.
pure Opus before considering it the default.

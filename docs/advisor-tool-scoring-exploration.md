# Exploration: advisor-tool scoring (Sonnet-5 executor + Opus advisor)

> **Status: exploration only — no code changed.** This weighs using Anthropic's **advisor tool**
> (beta) for the LLM deep-score step: a cheaper *executor* model does the bulk generation while a
> more capable *advisor* model is consulted for the hard judgment calls, aiming for **Opus-tier
> matching quality at closer-to-Sonnet cost**. It maps the idea onto the current scorer, flags two
> things that must be verified before committing, and lays out a phased, opt-in path.

## What the advisor tool is

The advisor tool pairs two models on a single Messages request:

- **Executor** — the top-level `model` on the request. Does most of the token generation. Faster/cheaper.
- **Advisor** — a `model` named *inside* the tool definition. A higher-intelligence model consulted
  for strategic guidance mid-generation (planning), not for producing the bulk of the output.

It is a **server-side** tool (no client tool-result round-trip) and is **beta-gated**. Shape:

```jsonc
// one entry in `tools`
{ "type": "advisor_20260301", "name": "advisor", "model": "claude-opus-4-8" }
```

Called via the beta Messages API with `betas: ["advisor-tool-2026-03-01"]`. The advisor's
`advisor_tool_result` blocks come back in `response.content`; in multi-turn use they must be echoed
back on the next turn (not relevant to us — scoring is single-turn).

**Availability:** beta on the **first-party Anthropic API** and **Claude Platform on AWS**; **not** on
Bedrock, Vertex, or Microsoft Foundry. job-hunter's scorer talks to the first-party API
(`new Anthropic({ apiKey })` in `src/matching/llm-client.ts`), so it qualifies.

## Why it fits job matching

Scoring a posting against a resume is exactly the shape the advisor tool targets: most of the output
(the rationale, the matched/missing skill lists) is routine generation an executor handles fine, but
the *score itself* and the honest gap assessment are the judgment call where a stronger model earns
its cost. Instead of paying Opus rates for every deep score, the executor carries the volume and the
advisor is consulted where intelligence matters — the promise being Opus-quality scores without the
full Opus bill.

## How it maps onto the current code

The deep scorer is small and already isolated behind a seam, so this is additive:

- **`src/matching/llm-client.ts` — `AnthropicLlmClient.score()`** is the only call site. Today it uses
  `client.messages.parse({ model, output_config: { effort, format }, system: [{…cache_control}], … })`.
  Advisor mode changes this call to: set `model` = the executor (the configured scorer model), add the
  advisor tool block to a `tools` array, and go through the **beta** client
  (`client.beta.messages.create` / the beta parse helper) with the beta flag.
- **`src/matching/llm-providers.ts`** already carries per-provider model config (`defaultModel`,
  `createClient`). An advisor model + on/off toggle belong here (or in settings via
  `resolve-settings.ts`), threaded into `createClient` the same way `onUsage` already is.
- **`src/matching/llm-usage.ts`** — the advisor consultation adds tokens under a different accounting
  line; extend `LlmUsage`/the summary so `score`'s usage report shows executor vs. advisor spend (we
  already surface cache hit/miss there, so this is the natural home).
- The **triager** (`triage-client.ts`) is deliberately *not* a candidate — title triage is a
  keep/drop call where a cheap model is already the right tool; the advisor's value is in the deep score.

Because the `LlmClient` interface (`{ system, user }` in, validated `LlmMatchPayload` out) doesn't
change, `LlmScorer`, `createAbortingScorer`, `runScoreRun`, the prompt builder, and every test double
are untouched. The change is sealed inside the concrete Anthropic client.

## Model compatibility (confirmed) + one thing still to verify

### Sonnet 5 + Opus advisor IS a valid pair
Per the [live advisor-tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool#model-compatibility),
the advisor must be Sonnet 4.6 or more capable **and** at least as capable as the executor. The
relevant rows:

| Executor (request `model`) | Valid advisor (tool `model`) |
|---|---|
| `claude-sonnet-5` | `claude-fable-5`, `claude-mythos-5`, `claude-opus-4-8`, `claude-opus-4-7` |
| `claude-sonnet-4-6` | `claude-fable-5`, `claude-mythos-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6` |
| `claude-haiku-4-5` | (same advisor set as Sonnet 4.6) |

So **`claude-sonnet-5` executor + `claude-opus-4-8` advisor is documented as valid** — the earlier
concern (Sonnet 5 missing from the pairing table) was a stale cached reference, now corrected. An
invalid pair still returns `400 invalid_request_error`, so the probe should confirm the exact pair we
ship. Note the advisor tool is beta on the **first-party API + Claude Platform on AWS** only (not
Bedrock/Vertex/Foundry) — fine for our first-party-API scorer.

### The one real open question: structured output + advisor tool composition
Our scorer relies on `messages.parse()` + `output_config.format` (a zod schema) to get a validated
`LlmMatchPayload` back. The advisor tool is a **beta** server-side tool, so we need to confirm that
(a) the beta Messages endpoint still supports `output_config` structured output, and (b) the parse
helper works under `client.beta.messages.create`. If they don't compose, the fallback is to drop
`messages.parse` for this path and validate manually with `MatchPayloadSchema.safeParse` — which the
`LlmScorer` boundary **already does** as belt-and-suspenders, so degrading gracefully is cheap.

## Cost & quality

- **vs. pure Sonnet (today's default):** advisor mode costs *more* per deep score — you pay for the
  advisor consultation on top of the executor. The bet is that the quality lift (better-calibrated
  scores, more honest gap detection) is worth it on the handful of postings that survive triage.
- **vs. pure Opus:** advisor mode should cost *less* — the executor, not Opus, generates the bulk of
  the tokens — while approaching Opus-level judgment. That's the whole point.
- Deep scores are already **bounded** (`score --limit`, the triage gate), so the blast radius is
  small and easy to preview. Update the `cost` estimate in `llm-providers.ts` (used by
  `score --dry-run`) to reflect advisor pricing so the preview stays honest.
- **Usage accounting is split.** Advisor calls are a separate sub-inference billed at the advisor
  model's rates and reported under `usage.iterations[]` (entries with `type: "advisor_message"` vs
  `type: "message"`); the **top-level `usage` reflects executor tokens only**. Our `UsageAccumulator`
  (which reads top-level `usage`) would therefore undercount cost — it must sum `usage.iterations[]`
  to capture advisor spend. Also relevant to caching: the advisor accepts its own `caching`
  switch, distinct from the `cache_control` breakpoint on our system block.
- **Prompt caching still applies** to the cached system prefix (see `docs/prompt-caching.md`); confirm
  the advisor path doesn't disturb `cache_control` on the system block.

## Privacy / threat model

No change to the privacy posture. Advisor mode sends the **same data** we already send to Anthropic
for scoring — the profile (system prefix) + the posting (user turn). The advisor model runs
server-side at Anthropic; there is no new data egress and nothing new stored. The resume still never
leaves the machine except as today's scoring prompt.

## A phased path

- **Phase 0 — verify (no app code). ✅ Probe built — `scripts/smoke-advisor.ts` (`npm run smoke:advisor`).**
  Resolves the structured-output composition question and confirms the exact model pair against a real
  key. Build instructions were in [`docs/advisor-tool-phase0-handoff.md`](advisor-tool-phase0-handoff.md).
  **Pre-run findings (from docs + the installed SDK, before the live run):**
  - The SDK exposes both `client.beta.messages.parse` and a dedicated **`betaZodOutputFormat`** helper
    (`@anthropic-ai/sdk/helpers/beta/zod`) — the beta-endpoint mirror of the `zodOutputFormat` +
    `messages.parse` our scorer uses today. The probe's variant (a) wires exactly that
    (`beta.messages.parse` + `betaZodOutputFormat(MatchPayloadSchema)` + the advisor tool) and it
    **typechecks clean**, so the beta `output_config.format` type accepts the composition. Strong signal
    structured output composes; the live run confirms `parsed_output` is actually populated at runtime.
  - The probe tries variant (a) first and falls back to variant (b) (`beta.messages.create` + manual
    `MatchPayloadSchema.safeParse` of the text block) only if (a) errors — so it records which path we
    must ship on.
  - It runs both `claude-sonnet-5` + `claude-opus-4-8` (target) and `claude-sonnet-4-6` +
    `claude-opus-4-8` (documented fallback), catching per-pair `400`s so one bad pair doesn't hide the
    other, and prints the full `usage.iterations[]` split (executor `message` vs advisor
    `advisor_message` output tokens) so the Phase 1 `UsageAccumulator` change starts from real numbers.
  - **Still requires the live run** (needs `ANTHROPIC_API_KEY` with advisor-beta access — CI/sandbox
    can't). After running, record the winning variant, the token split, and any `400` back into this doc.
- **Phase 1 — prototype behind a setting.** Add `scorerAdvisorModel` (+ an on/off) to settings and
  `llm-providers.ts`; branch `AnthropicLlmClient.score()` to the advisor path when set. **Off by
  default.** Extend the usage summary to split executor/advisor tokens.
- **Phase 2 — measure.** Deep-score the same batch three ways (current Sonnet, advisor mode, pure
  Opus) and compare scores/rationales + cost on real postings. Keep it if the quality-per-dollar wins.
- **Phase 3 — adopt (optional).** If it wins, make advisor mode the recommended config and document
  the executor/advisor pair in the README + settings help. Leave pure-Sonnet as the cheap default.

## Bottom line

The advisor tool is a clean fit for the deep-score step and slots behind the existing `LlmClient`
seam with no ripple into the rest of the pipeline. The idea is sound and the model pairing is
confirmed (`claude-sonnet-5` executor + `claude-opus-4-8` advisor is valid). One specific still gates
it — whether the beta advisor tool composes with our structured-output parse — plus the usage-
accounting change (sum `usage.iterations[]`). Both are settled by the Phase 0 smoke probe; build
instructions are in [`docs/advisor-tool-phase0-handoff.md`](advisor-tool-phase0-handoff.md).

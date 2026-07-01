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

## Two things to verify BEFORE committing

These are the reason this is an exploration and not a PR.

### 1. The Sonnet-5 ↔ advisor pairing is not in the documented table
The advisor model **must be at least as capable as the executor**, or the request returns
`400 invalid_request_error`. The documented valid pairs (tool version `advisor_20260301`, dated
2026-03-01) are:

| Executor (request `model`) | Valid advisor (tool `model`) |
|---|---|
| `claude-haiku-4-5` / `claude-sonnet-4-6` / `claude-opus-4-6` / `claude-opus-4-7` | `claude-opus-4-8` or `claude-opus-4-7` |
| `claude-opus-4-8` | `claude-opus-4-8` only |

**`claude-sonnet-5` does not appear in this table** — it is newer than the published pairing list. So
"Sonnet 5 executor + Opus advisor" is **not documented as valid yet**; it may be accepted, may require
a Claude-5-tier advisor, or may be rejected. Verify against live docs / a probe request before
building on it. A safe, fully-documented starting pair today is **`claude-sonnet-4-6` executor +
`claude-opus-4-8` advisor** — we can prototype with that and swap the executor to `claude-sonnet-5`
once its pairing is confirmed.

### 2. Structured output + advisor tool composition
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
- **Prompt caching still applies** to the cached system prefix (see `docs/prompt-caching.md`); confirm
  the advisor path doesn't disturb `cache_control` on the system block.

## Privacy / threat model

No change to the privacy posture. Advisor mode sends the **same data** we already send to Anthropic
for scoring — the profile (system prefix) + the posting (user turn). The advisor model runs
server-side at Anthropic; there is no new data egress and nothing new stored. The resume still never
leaves the machine except as today's scoring prompt.

## A phased path

- **Phase 0 — verify (no app code).** A throwaway `smoke:advisor` script: one deep-score request with
  the advisor tool, first as the documented `claude-sonnet-4-6` + `claude-opus-4-8` pair, then probing
  `claude-sonnet-5` as executor. Confirm (1) the pairing is accepted and (2) structured output still
  parses. This resolves both open questions cheaply against a real key.
- **Phase 1 — prototype behind a setting.** Add `scorerAdvisorModel` (+ an on/off) to settings and
  `llm-providers.ts`; branch `AnthropicLlmClient.score()` to the advisor path when set. **Off by
  default.** Extend the usage summary to split executor/advisor tokens.
- **Phase 2 — measure.** Deep-score the same batch three ways (current Sonnet, advisor mode, pure
  Opus) and compare scores/rationales + cost on real postings. Keep it if the quality-per-dollar wins.
- **Phase 3 — adopt (optional).** If it wins, make advisor mode the recommended config and document
  the executor/advisor pair in the README + settings help. Leave pure-Sonnet as the cheap default.

## Bottom line

The advisor tool is a clean fit for the deep-score step and slots behind the existing `LlmClient`
seam with no ripple into the rest of the pipeline. The idea is sound; two specifics gate it — whether
`claude-sonnet-5` is a currently-valid executor for an Opus advisor, and whether the beta advisor tool
composes with our structured-output parse. Both are answerable with a ~20-line smoke probe (Phase 0)
before any real implementation. Recommended next step: run Phase 0 against the live key, starting from
the fully-documented `claude-sonnet-4-6` + `claude-opus-4-8` pair.

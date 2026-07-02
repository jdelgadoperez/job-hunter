# Exploration: advisor-tool scoring (Sonnet-5 executor + Opus advisor)

> **Status: exploration complete — VERDICT: do not adopt (no app code changed).** This weighed using
> Anthropic's **advisor tool** (beta) for the LLM deep-score step: a cheaper *executor* model does the
> bulk generation while a more capable *advisor* model is consulted for the hard judgment calls,
> aiming for **Opus-tier matching quality at closer-to-Sonnet cost**. A live Phase 0 probe
> (`scripts/smoke-advisor.ts`) settled it: the tool is a fundamental mismatch for single-turn scoring
> — inert unforced, and a non-terminating, Opus-cost-dominated agentic loop when forced. See
> **[Phase 0 results](#phase-0-results-live-run-2026-07-02)** and the **[Verdict](#verdict-do-not-adopt-the-advisor-tool-for-the-deep-score-step-as-designed)**.
> The sections below are the original exploration, preserved for context; the verdict supersedes the
> "phased path" it proposed.

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

## Phase 0 results (live run, 2026-07-02)

Ran `npm run smoke:advisor` against the live API with a beta-enabled key. Findings:

1. **✅ Structured output composes (UNFORCED) — no fallback needed.** Variant (a),
   `client.beta.messages.parse` + `betaZodOutputFormat(MatchPayloadSchema)` + the advisor tool in
   `tools`, returned a populated `parsed_output` (a valid `LlmMatchPayload`) on **both** model pairs.
   Variant (b) — manual `safeParse` — was never reached. Note this holds only when the advisor is
   *not* forced; see finding 5, where forcing the consult breaks structured output entirely.
2. **✅ Both model pairs accepted (no `400`).** `claude-sonnet-5` + `claude-opus-4-8` (score 90) and
   `claude-sonnet-4-6` + `claude-opus-4-8` (score 88) both succeeded. The 90-vs-88 gap is ordinary
   model variance, **not** an advisor effect — see finding 4.
3. **✅ Prompt caching survives.** The `cache_control: { type: "ephemeral" }` system prefix cached
   normally (`cache_creation_input_tokens` = 1693 / 1154 on the two runs). Advisor mode does not
   disturb our system-block caching.
4. **⚠️ CRITICAL — the advisor was never actually consulted.** On both runs
   `usage.iterations[]` held a **single `type: "message"` entry and zero `advisor_message`
   entries** (advisor output tokens: 0). The advisor tool was *available* but the executor **chose
   not to call it** — scoring one posting is single-turn with nothing to plan, exactly the case the
   [docs flag as a weak fit](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool#when-to-use-it)
   ("weaker fit for single-turn Q&A — nothing to plan"). So these runs produced **Sonnet-solo
   quality at Sonnet-solo cost**, not the Opus-advised quality the whole idea depends on. Merely
   attaching the tool does nothing for our workload.

5. **⛔ FORCING the consult breaks the score — `pause_turn`, no `parsed_output`, runaway advisor
   cost.** The probe was extended to re-run each pair with `tool_choice: { type: "tool", name:
   "advisor" }` forcing the consult. The forced runs DID invoke the Opus advisor (many
   `advisor_message` iterations), but the result was **unusable for scoring**:
   - **No structured output.** Both forced runs returned `parsed_output === null` with
     `stop_reason: "pause_turn"`. Forcing the advisor turned the single-shot score into a **multi-turn
     agentic loop** that never terminated with a final structured answer inside `max_tokens: 2048`.
     `pause_turn` means the turn was suspended mid-loop — our `messages.parse` call gets nothing back
     to validate. Forced advisor + single-call structured output **do not compose** for this workload.
   - **The advisor dominates cost, inverting the premise.** `tool_choice: advisor` forced a consult on
     *every* loop iteration, not once. Observed output-token split (advisor vs. executor):

     | Pair | Executor out | Advisor out (Opus 4.8) | Advisor ≈ | Terminal stop_reason |
     |---|---|---|---|---|
     | `claude-sonnet-5` + `claude-opus-4-8` | 936 | 3,872 | ~4× executor | `pause_turn` (null output) |
     | `claude-sonnet-4-6` + `claude-opus-4-8` | 356 | 8,357 | ~23× executor | `pause_turn` (null output) |

     The advisor out-generated the executor by 4–23×, at Opus rates. The whole idea was "bulk tokens
     at executor rates, occasional Opus guidance" — forced, it's the reverse: an Opus-priced firehose
     that still produces no score.
   - **Caching note:** the forced runs read the cached prefix (`cache_read_input_tokens` in the tens
     of thousands), so caching isn't the problem — the non-termination and per-iteration forcing are.

6. **⛔ RE-PROBE — "available, not forced, let the agent decide" is also inert, even on hard scores.**
   The natural follow-up: maybe the advisor is skipped only because the test posting is an *obvious*
   match — give the agent a genuinely ambiguous score and explicit permission to consult, and it might
   reach for the advisor on its own. Tested directly: added a HARD scenario (a backend/data-engineering
   candidate — Python/Django/Airflow/Spark — against a *senior frontend design-systems* role, a real
   transferable-skills judgment call) with a scoring instruction that **explicitly permits** consulting
   an advisor for borderline calls. Ran it unforced on both pairs. Result: **the agent consulted the
   advisor 0 times on all four unforced runs** (both easy, both hard). On the hard case it scored the
   candidate **12 and 18** with crisp, correct rationales ("the gap is too wide", "not a generalist
   role") — the model was *confident*, so it correctly saw nothing to consult about. The lesson: for
   single-posting scoring the model reaches a well-calibrated answer in one shot; there is no
   deliberation phase where a second opinion changes the outcome, so "let the agent decide whether to
   consult" reliably resolves to "don't." Making the tool merely available buys nothing but surface
   area. (Reproduce: `npm run smoke:advisor` — watch for the `★ AGENT SELF-CONSULTED` vs `○ did NOT
   consult` lines.)

## Verdict: do NOT adopt the advisor tool for the deep-score step (as designed)

Phase 0 is **conclusive, and the answer is no** — but for a better reason than the original blockers:

- The two questions this exploration set out to answer are both technically **green**: structured
  output composes on `beta.messages.parse` (unforced), and both model pairs are valid (no `400`).
- But the workload is a **fundamental mismatch** for the tool. Scoring one posting against a resume is
  single-turn with nothing to plan — exactly the case the docs call a weak fit. In practice:
  - **Unforced** — even "available, not forced, agent decides" — the agent consults the advisor
    **zero times**, on easy *and* genuinely-hard/ambiguous scores where consulting was explicitly
    invited (findings 4 and 6) → Sonnet-solo quality at Sonnet-solo cost. The tool is inert.
  - **Forced**, the consult spins up a non-terminating agentic loop that never returns
    `parsed_output` and runs the Opus advisor 4–23× hotter than the executor (finding 5). The tool is
    actively harmful to both correctness and cost.

There is no middle setting that gives "Opus-quality score at Sonnet cost" for a single-shot
structured score. The advisor tool is built for long-horizon agentic loops (coding agents, multi-step
research) where planning pays off across many turns — not a one-shot classify/score call.

**If we still want Opus-tier score calibration**, the honest options are the plain ones the advisor
tool was meant to avoid, and they're simpler here:
- **Opus-solo on the deep score** behind a setting (off by default), accepting the cost, measured
  against Sonnet-solo on real postings. One call, structured output, no agentic loop.
- **A two-call pattern we control**: Sonnet scores, then Opus reviews/adjusts only the borderline
  scores — but that's a bespoke pipeline, not the advisor tool, and only worth it if Phase-2-style
  measurement shows Sonnet-solo is actually miscalibrated on our postings.

**Recommended next step:** shelve the advisor-tool approach. If score quality is a real concern,
open a separate, smaller exploration for **Opus-solo deep-score behind a setting** and measure it
before building anything. Phase 1 (advisor behind a setting) as previously sketched should **not** be
built — it would ship the inverted-cost, no-output behavior above.

The probe (`scripts/smoke-advisor.ts`) is kept as the reproducible evidence for this verdict and as a
template for the Opus-solo measurement if we pursue it.

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

## A phased path (SUPERSEDED by the Phase 0 verdict above)

> The phased path below was the plan *before* the live probe. Phase 0 ran and returned "do not adopt"
> — Phases 1–3 should **not** be built. Kept here to show what was originally proposed and why the
> evidence redirected it.

- **Phase 0 — verify (no app code). ✅ Probe built + run — `scripts/smoke-advisor.ts` (`npm run smoke:advisor`).**
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

**The advisor tool is not the right fit for the deep-score step — Phase 0 settled it, verdict: do not
adopt.** The `LlmClient` seam would have made the integration clean, and the model pairing is valid
(`claude-sonnet-5` + `claude-opus-4-8`), but the *workload* is the problem, not the plumbing: a
single-turn structured score has nothing for an advisor to plan. Unforced, the executor ignores the
advisor (Sonnet-solo at Sonnet cost); forced, the consult becomes a non-terminating agentic loop that
returns no `parsed_output` (`pause_turn`) and runs the Opus advisor 4–23× hotter than the executor —
the exact inverse of the cost premise. See [Phase 0 results](#phase-0-results-live-run-2026-07-02) and
[Verdict](#verdict-do-not-adopt-the-advisor-tool-for-the-deep-score-step-as-designed) for the numbers.

If Opus-tier score calibration is worth pursuing, do it with a plain **Opus-solo deep score behind a
setting** (one call, structured output, no agentic loop) and *measure it against Sonnet-solo on real
postings first* — a separate, smaller exploration. Don't build the advisor Phases 1–3.

# LLM Scorer & API-Key Resolution Implementation Plan (Plan 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the second `Scorer` implementation from the design spec — an `LlmScorer` that calls a hosted LLM for semantic skill alignment, richer gap analysis, and a populated `MatchResult.rationale`, with the local `HeuristicScorer` as the always-available fallback. **Claude is the only engine shipped in this plan**, but the seam is provider-agnostic so a second engine (OpenAI, Gemini, …) is a later drop-in — one new client file plus one registry entry — not a refactor. Resolve the active provider, its API key, and the model from the `settings` table (where the Plan 5 UI will write them), and wire the whole thing behind a dependency-injected `LlmClient` seam so the automated suite runs with **no live API calls**. Still **no Electron and no UI** — this stays the headless engine.

**Architecture:** All LLM access goes through a small, **dependency-injected, provider-agnostic** `LlmClient` seam, mirroring the Plan 2 `Fetcher` pattern (`HttpFetcher`/`FakeFetcher`). The seam takes a `{ system, user }` request and returns a zod-validated `LlmMatchPayload`; each provider's structured-output mechanics are sealed *inside* its client, so the rest of the system never learns which engine ran. The production `AnthropicLlmClient` wraps `@anthropic-ai/sdk` and is exercised only by an opt-in smoke script; `FakeLlmClient` backs every unit test with canned payloads (and simulated errors/refusals). A tiny **provider registry** (`LLM_PROVIDERS`) maps a provider id → `{ apiKeySetting, defaultModel, createClient }`; it has exactly one entry (`anthropic`) today, and adding `openai`/`gemini` later means appending an entry + a sibling client class with no change to `LlmScorer`, the prompt builder, or the resolvers. Prompt construction and the payload→`MatchResult` mapping are **pure functions** tested directly. The model's structured output is constrained with the SDK's structured-outputs path (`messages.parse()` + `zodOutputFormat`) and the same payload is re-validated with **zod** before it becomes a `MatchResult` — the "degrade, never crash" guarantee in code. On **no key, an API error, or a refusal**, `LlmScorer` returns the heuristic result *and* surfaces a `Warning` (collected like connector warnings), so the user can see that LLM scoring was unavailable. The `Scorer` interface is unchanged (it already returns `MatchResult | Promise<MatchResult>`); warnings are emitted through an injected callback so the interface stays intact.

**Tech Stack additions:** **`@anthropic-ai/sdk`** (latest) for the Messages API; `zodOutputFormat` from `@anthropic-ai/sdk/helpers/zod` for structured output. **zod** (already a dependency) for boundary validation. Biome + Vitest + tsc toolchain unchanged from Plans 1–2.

**Model & cost decisions (settled with the maintainer):**
- Default model **`claude-sonnet-4-6`**, stored as the `settings` value `scorerModel` so the UI can override it to Opus/Haiku without a code change.
- **Thinking disabled** (`thinking: {type: "disabled"}`) and **`effort: "low"`** — scoring is a bounded, shallow judgment fired once per posting; adaptive thinking would add latency/tokens to every call for little gain.
- **`messages.parse()` + `zodOutputFormat`** for schema-valid structured output; `max_tokens` ~1024.
- **Prompt caching:** the system instructions + serialized `SkillProfile` are byte-identical across every posting in a run, so they go in a cached `system` block (`cache_control: {type: "ephemeral"}`); the posting goes in the volatile user message. Caching may silently no-op when the prefix is below the model minimum (2048 tokens on Sonnet) — wiring it is free and helps for large profiles.
- **No Batch API** in iteration 1 (it's async up to 24h — wrong for an interactive search). Per-call 429/5xx retry is handled automatically by the SDK; cross-posting concurrency + politeness belong to the Plan 4 pipeline (`p-limit`), not the scorer.

## Global Constraints

- **Inherit Plans 1–2 constraints:** TypeScript strict ESM, no `any`, no non-null `!`, `node:`-prefixed core imports, extensionless relative imports + `@app/*` alias, colocated `*.test.ts`, Biome-clean (double quotes, 2-space, 100 width), Conventional Commits.
- **Provider-agnostic, Claude-only-now.** Nothing outside a provider's own client file may reference a provider-specific SDK, model id, or setting name. `LlmScorer`, `buildScorePrompt`, `toMatchResult`, and `resolveScorer` go through the `LlmClient` interface and the registry only. Shipping a second engine must not touch any of them.
- **No live network in the automated suite.** Every unit that talks to Claude takes an `LlmClient`. Tests pass a `FakeLlmClient` returning canned payloads or throwing. The real SDK-backed `AnthropicLlmClient` is the production default and is exercised only by the opt-in smoke script (Task 6).
- **Validate the model payload with zod.** A payload that fails its schema is treated exactly like an API failure: degrade to the heuristic and emit a `Warning` — never a thrown error that aborts scoring.
- **Degrade, never crash.** No key, API error, refusal, or malformed payload → heuristic `MatchResult` + a `Warning`. `LlmScorer.score` never rejects.
- **`Scorer` interface unchanged.** `score(profile, posting): MatchResult | Promise<MatchResult>` stays as-is; `HeuristicScorer` is untouched. Warnings flow through an injected `onWarning?` callback.
- **No secrets in code or fixtures.** The smoke script reads the key from `ANTHROPIC_API_KEY`; no key is ever committed.

---

### Task 1: Provider, API key & model resolution

> Depends on the registry shape from Task 2 (`LlmProviderConfig`, `LLM_PROVIDERS`, `DEFAULT_PROVIDER`). If implementing top-down, define those types/constants first (a stub registry with the `anthropic` entry's metadata is enough) and fill in `createClient` in Task 2.

**Files:**
- Create: `src/matching/resolve-settings.ts`
- Test: `src/matching/resolve-settings.test.ts`

**Interfaces:**
- Consumes: a structural `SettingsReader` = `{ getSetting(key: string): string | undefined }` (satisfied by `Repository`); the registry from Task 2.
- Produces:
  - `PROVIDER_SETTING = "scorerProvider"`, `MODEL_SETTING = "scorerModel"` (exported constants). Per-provider key setting names live on the registry config (`anthropic` → `apiKeySetting: "anthropicApiKey"`), so no provider-specific constant leaks here.
  - `resolveProvider(settings: SettingsReader): LlmProviderConfig` — reads `PROVIDER_SETTING`, looks it up in `LLM_PROVIDERS`, and falls back to `DEFAULT_PROVIDER` when unset or unrecognized.
  - `resolveApiKey(settings: SettingsReader, provider: LlmProviderConfig): string | undefined` — returns the trimmed value of `provider.apiKeySetting`, or `undefined` when unset/blank.
  - `resolveScorerModel(settings: SettingsReader, provider: LlmProviderConfig): string` — returns `MODEL_SETTING` if set, else `provider.defaultModel`.

**Contract:**
- `resolveProvider` returns the `anthropic` config when the setting is absent, blank, or an unknown id; returns the matching config when a known id is set.
- `resolveApiKey` returns the trimmed per-provider key; a whitespace-only or absent value yields `undefined`.
- `resolveScorerModel` returns the stored value when present, else the provider's `defaultModel`.

- [ ] **Step 1:** failing test against a fake `SettingsReader` (and a round-trip through a temp `Repository` to prove the `settings` table wiring), covering unknown-provider fallback.
- [ ] **Step 2:** run → fails (module not found).
- [ ] **Step 3:** implement the three pure resolvers + constants.
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5:** commit — `feat: resolve scorer provider, api key, and model from settings`.

---

### Task 2: LLM client seam + match payload schema + provider registry

**Files:**
- Create: `src/matching/llm-client.ts`
- Create: `src/matching/llm-schema.ts`
- Create: `src/matching/llm-providers.ts`
- Test: `src/matching/llm-client.test.ts` (covers `FakeLlmClient` + the schema; `AnthropicLlmClient` is covered by the smoke script, like `HttpFetcher`)
- Test: `src/matching/llm-providers.test.ts` (registry shape: every entry's `apiKeySetting`/`defaultModel` are non-empty, `DEFAULT_PROVIDER` is a key, `createClient` returns an `LlmClient`)

**Interfaces:**
- Consumes: `@anthropic-ai/sdk`, `zodOutputFormat` (`@anthropic-ai/sdk/helpers/zod`), zod.
- Produces (`llm-schema.ts`):
  - `MatchPayloadSchema` — zod object: `score` (`number().min(0).max(100)`), `matchedSkills` (`array(string())`), `missingSkills` (`array(string())`), `rationale` (`string()`). `additionalProperties` disallowed (strict object) for structured-output compatibility.
  - `type LlmMatchPayload = z.infer<typeof MatchPayloadSchema>`.
- Produces (`llm-client.ts`):
  - `type LlmScoreRequest = { system: string; user: string }`.
  - `interface LlmClient { score(request: LlmScoreRequest): Promise<LlmMatchPayload> }`.
  - `class AnthropicLlmClient implements LlmClient` — constructed with `{ apiKey: string; model: string }`; calls `client.messages.parse({ model, max_tokens: 1024, thinking: { type: "disabled" }, output_config: { effort: "low", format: zodOutputFormat(MatchPayloadSchema) }, system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: request.user }] })`; returns `response.parsed_output` and **throws** when it is null (refusal / `max_tokens` / parse failure).
  - `class FakeLlmClient implements LlmClient` — constructed with either a canned `LlmMatchPayload` (or a `(req) => payload` function) **or** an `Error` to throw, so tests can drive both the success and failure branches with no network.
- Produces (`llm-providers.ts`):
  - `type LlmProviderId = "anthropic"` (a string-literal union that grows as engines are added).
  - `interface LlmProviderConfig { id: LlmProviderId; apiKeySetting: string; defaultModel: string; createClient(opts: { apiKey: string; model: string }): LlmClient }`.
  - `const LLM_PROVIDERS: Record<LlmProviderId, LlmProviderConfig>` — one entry today: `anthropic` → `{ id: "anthropic", apiKeySetting: "anthropicApiKey", defaultModel: "claude-sonnet-4-6", createClient: (opts) => new AnthropicLlmClient(opts) }`.
  - `const DEFAULT_PROVIDER: LlmProviderId = "anthropic"`.

**Contract:**
- `MatchPayloadSchema` accepts a well-formed payload and rejects ones with a missing field, an out-of-range `score`, or wrong types.
- `FakeLlmClient` returns its canned payload for any request; the error-configured variant rejects.
- Every `LLM_PROVIDERS` entry has a non-empty `apiKeySetting` and `defaultModel`, its key matches `config.id`, and `DEFAULT_PROVIDER` is a valid key.

- [ ] **Step 1:** add `@anthropic-ai/sdk` (`npm install @anthropic-ai/sdk`, pin the resolved version in `package.json`); write the failing schema + `FakeLlmClient` + registry tests.
- [ ] **Step 2:** run → fails (module not found).
- [ ] **Step 3:** implement `llm-schema.ts`, `llm-client.ts`, and `llm-providers.ts`. Keep all SDK-specific config (model, thinking, effort, cache_control, `parse`) inside `AnthropicLlmClient`; the registry is the only place that names a concrete provider.
- [ ] **Step 4:** run → PASS; `npm run typecheck` clean against the SDK types.
- [ ] **Step 5:** commit — `feat: add provider-agnostic llm client seam, schema, and registry`.

---

### Task 3: Prompt builder & payload→MatchResult mapping (pure)

**Files:**
- Create: `src/matching/score-prompt.ts`
- Test: `src/matching/score-prompt.test.ts`

**Interfaces:**
- Consumes: `SkillProfile`, `JobPosting`, `MatchResult`, `LlmMatchPayload`.
- Produces:
  - `buildScorePrompt(profile: SkillProfile, posting: JobPosting): LlmScoreRequest` — `system` holds the scoring instructions **and** the serialized profile (the stable, cacheable prefix); `user` holds the posting title/description (the volatile part). The instructions tell the model to return semantic-alignment `score` 0–100, the profile skills present in the posting (`matchedSkills`), the posting's required skills absent from the profile (`missingSkills`), and a one-paragraph `rationale`.
  - `toMatchResult(payload: LlmMatchPayload): MatchResult` — clamps `score` to 0–100 and `Math.round`s it, passes through `matchedSkills`/`missingSkills`/`rationale`.

**Contract:**
- `buildScorePrompt` puts the profile (skills, roleKeywords, categories) in `system` and the posting's title + description in `user`; identical profiles produce byte-identical `system` strings (cache stability), and the posting text never leaks into `system`.
- `toMatchResult` clamps a `120` score to `100` and a negative score to `0`, and preserves the skill arrays + rationale.

- [ ] **Step 1:** failing test for both pure functions.
- [ ] **Step 2:** run → fails.
- [ ] **Step 3:** implement both.
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5:** commit — `feat: add llm score prompt builder and match-result mapping`.

---

### Task 4: LlmScorer (degrade-to-heuristic + Warning)

**Files:**
- Create: `src/matching/llm-scorer.ts`
- Test: `src/matching/llm-scorer.test.ts`

**Interfaces:**
- Consumes: `LlmClient` (Task 2), `buildScorePrompt`/`toMatchResult` (Task 3), `Scorer`/`MatchResult`/`Warning` (Plan 1), `MatchPayloadSchema` (re-validation).
- Produces:
  - `class LlmScorer implements Scorer` — `constructor(private readonly llm: LlmClient, private readonly fallback: Scorer, private readonly onWarning?: (w: Warning) => void)`.
  - `async score(profile, posting): Promise<MatchResult>`:
    1. `buildScorePrompt(profile, posting)` → `llm.score(...)`.
    2. re-validate the returned payload with `MatchPayloadSchema.safeParse` (belt-and-suspenders over the SDK's own validation, and the real validation point for `FakeLlmClient`).
    3. on success → `toMatchResult(payload)`.
    4. on **any** thrown error or failed `safeParse` → call `onWarning?.({ source: "llm-scorer", message })` and return `await this.fallback.score(profile, posting)`.

**Contract (all with `FakeLlmClient` — no network):**
- A canned valid payload → `MatchResult` with the LLM's score and a populated `rationale`; `onWarning` not called.
- A `FakeLlmClient` that throws (API error / refusal) → the result equals `fallback.score(...)` (rationale absent) **and** `onWarning` fired exactly once with `source: "llm-scorer"`.
- A `FakeLlmClient` returning a malformed payload (fails `safeParse`) → same heuristic-fallback + `Warning` behavior.
- `score` never rejects.

- [ ] **Step 1:** failing test with a `FakeLlmClient` (success), a throwing one, and a malformed-payload one; inject a real `HeuristicScorer` as the fallback and a warning-collector array as `onWarning`.
- [ ] **Step 2:** run → fails.
- [ ] **Step 3:** implement `LlmScorer`.
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5:** commit — `feat: add llm scorer with heuristic fallback and warnings`.

---

### Task 5: Scorer factory (key-aware selection)

**Files:**
- Create: `src/matching/resolve-scorer.ts`
- Test: `src/matching/resolve-scorer.test.ts`

**Interfaces:**
- Consumes: `resolveProvider`/`resolveApiKey`/`resolveScorerModel` (Task 1), the registry (Task 2), `LlmScorer` (Task 4), `HeuristicScorer` (Plan 1), `Warning`.
- Produces:
  - `type ResolveScorerDeps = { settings: SettingsReader; dictionary?: string[]; onWarning?: (w: Warning) => void; clientOverride?: (provider: LlmProviderConfig, opts: { apiKey: string; model: string }) => LlmClient }` — `clientOverride` defaults to `provider.createClient` and is injectable so the factory is testable with a `FakeLlmClient` for any provider.
  - `resolveScorer(deps: ResolveScorerDeps): Scorer`:
    - `provider = resolveProvider(settings)`, `key = resolveApiKey(settings, provider)`, `model = resolveScorerModel(settings, provider)`.
    - no key → emit one `Warning` (`source: "llm-scorer"`, "no API key configured for {provider.id}; using the free heuristic scorer") and return `new HeuristicScorer(dictionary)`.
    - key present → return `new LlmScorer((clientOverride ?? provider.createClient)({ apiKey: key, model }), new HeuristicScorer(dictionary), onWarning)`.

**Contract:**
- A `settings` stub with no key → returns a `HeuristicScorer` and fires the no-key `Warning` once (message names the resolved provider).
- A `settings` stub with a key + an injected `clientOverride` → returns an `LlmScorer`; scoring a posting routes through the fake client (assert the rationale appears), and the resolved model equals the `scorerModel` setting (assert the override received it).
- An unknown `scorerProvider` setting still resolves to `anthropic` (via `resolveProvider`) rather than erroring.

- [ ] **Step 1:** failing test for both branches with stubs + an injected `clientOverride`, including the unknown-provider case.
- [ ] **Step 2:** run → fails.
- [ ] **Step 3:** implement `resolveScorer`.
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5:** commit — `feat: add key-aware scorer factory`.

---

### Task 6: Opt-in live smoke script

**Files:**
- Create: `scripts/smoke-scorer.ts`
- Add npm script: `"smoke:scorer": "node --import tsx scripts/smoke-scorer.ts"` — **not** part of `npm test`.

**Purpose:** With a real `ANTHROPIC_API_KEY` in the environment, score a hard-coded sample `SkillProfile` against a sample `JobPosting` using the real `AnthropicLlmClient`, printing the `MatchResult` (score, matched/missing skills, rationale) and any warnings. Manual, excluded from CI, and the only place the live SDK path runs. Verifies the prompt + structured-output contract still holds against the real API when run intentionally. Exits with a clear message if the key is absent (never throws an unhandled error).

- [ ] **Step 1:** write the script (read key from env; build a `LlmScorer` directly with `AnthropicLlmClient` + `HeuristicScorer` fallback).
- [ ] **Step 2:** run it manually once with a real key to confirm the live structured output parses; **do not** commit any key.
- [ ] **Step 3:** commit — `chore: add opt-in llm scorer smoke script`.

---

## Self-Review

**Spec coverage (against the design doc, Matching module + API-key resolution):**
- `Scorer` interface with a heuristic and an LLM implementation → `HeuristicScorer` (Plan 1) + `LlmScorer` (Task 4). ✅
- LLM scorer adds semantic alignment, richer gap analysis, and a populated `rationale` → prompt + schema (Tasks 2–3). ✅
- LLM error → fall back to `HeuristicScorer` so a result is always produced → Task 4 (extended to no-key and malformed-payload, with a visible `Warning` per the maintainer's call). ✅
- API-key resolution in one testable place → `resolveProvider`/`resolveApiKey` (Task 1) + `resolveScorer` (Task 5). Resolution source is the `settings` table (the Plan 5 UI writes the provider/key/model; Plan 4 adds keychain storage). The spec's baked-in-key tier is **deferred** — see Out of scope. ✅
- Multi-engine readiness (maintainer's call: pluggable, Claude-only now) → provider-agnostic `LlmClient` + `LLM_PROVIDERS` registry (Task 2); `LlmScorer`, prompt builder, mapping, and resolvers are provider-blind. Adding OpenAI/Gemini later = one registry entry + one sibling client + its key setting, with no change to the tested core. ✅
- No real tokens spent in tests; mocked client proves both the success path and the error→heuristic fallback → `FakeLlmClient` across Tasks 2–5; live path only in the Task 6 smoke script. ✅
- Validate external data with zod → `MatchPayloadSchema` at the boundary (Tasks 2, 4). ✅

**Boundary with Plans 1–2:** consumes `Scorer`, `MatchResult`, `SkillProfile`, `JobPosting`, `Warning`, `HeuristicScorer`, and `Repository`'s `getSetting` unchanged. Produces new units `LlmClient`/`AnthropicLlmClient`/`FakeLlmClient`, `LlmScorer`, the pure prompt/mapping helpers, and the `resolveApiKey`/`resolveScorerModel`/`resolveScorer` resolvers. No changes to existing domain types or the `Scorer` interface.

**Out of scope (later plans):**
- **Additional engines** (OpenAI, Gemini, local models). The seam + registry make each a one-file drop-in, but no second provider, SDK, or live path ships in this plan. A future "additional engines" plan appends registry entries and the Settings-UI engine picker.
- The baked-in author's-key tier and OS-keychain storage of the key → Plan 4/5 (the headless layer reads whatever the UI persisted into `settings`; encryption-at-rest and the build-time key live with the Electron main process).
- Wiring `resolveScorer` into the discovery→matching→freshness→storage pipeline, concurrency/politeness for many-posting scoring runs, and streaming progress → Plan 4.
- The Settings UI for entering the key and choosing the model → Plan 5.
- Prompt-cache pre-warming and any batching/cost dashboards → deferred (caching breakpoint is wired in Task 2 but not pre-warmed).

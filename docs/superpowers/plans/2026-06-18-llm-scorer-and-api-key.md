# LLM Scorer & API-Key Resolution Implementation Plan (Plan 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the second `Scorer` implementation from the design spec — an `LlmScorer` that calls Claude for semantic skill alignment, richer gap analysis, and a populated `MatchResult.rationale`, with the local `HeuristicScorer` as the always-available fallback. Resolve the Anthropic API key from the `settings` table (where the Plan 5 UI will write it), and wire the whole thing behind a dependency-injected `LlmClient` seam so the automated suite runs with **no live API calls**. Still **no Electron and no UI** — this stays the headless engine.

**Architecture:** All Anthropic access goes through a small, **dependency-injected** `LlmClient` seam, mirroring the Plan 2 `Fetcher` pattern (`HttpFetcher`/`FakeFetcher`). The production `AnthropicLlmClient` wraps `@anthropic-ai/sdk` and is exercised only by an opt-in smoke script; `FakeLlmClient` backs every unit test with canned payloads (and simulated errors/refusals). Prompt construction and the payload→`MatchResult` mapping are **pure functions** tested directly. The model's structured output is constrained with the SDK's structured-outputs path (`messages.parse()` + `zodOutputFormat`) and the same payload is re-validated with **zod** before it becomes a `MatchResult` — the "degrade, never crash" guarantee in code. On **no key, an API error, or a refusal**, `LlmScorer` returns the heuristic result *and* surfaces a `Warning` (collected like connector warnings), so the user can see that LLM scoring was unavailable. The `Scorer` interface is unchanged (it already returns `MatchResult | Promise<MatchResult>`); warnings are emitted through an injected callback so the interface stays intact.

**Tech Stack additions:** **`@anthropic-ai/sdk`** (latest) for the Messages API; `zodOutputFormat` from `@anthropic-ai/sdk/helpers/zod` for structured output. **zod** (already a dependency) for boundary validation. Biome + Vitest + tsc toolchain unchanged from Plans 1–2.

**Model & cost decisions (settled with the maintainer):**
- Default model **`claude-sonnet-4-6`**, stored as the `settings` value `scorerModel` so the UI can override it to Opus/Haiku without a code change.
- **Thinking disabled** (`thinking: {type: "disabled"}`) and **`effort: "low"`** — scoring is a bounded, shallow judgment fired once per posting; adaptive thinking would add latency/tokens to every call for little gain.
- **`messages.parse()` + `zodOutputFormat`** for schema-valid structured output; `max_tokens` ~1024.
- **Prompt caching:** the system instructions + serialized `SkillProfile` are byte-identical across every posting in a run, so they go in a cached `system` block (`cache_control: {type: "ephemeral"}`); the posting goes in the volatile user message. Caching may silently no-op when the prefix is below the model minimum (2048 tokens on Sonnet) — wiring it is free and helps for large profiles.
- **No Batch API** in iteration 1 (it's async up to 24h — wrong for an interactive search). Per-call 429/5xx retry is handled automatically by the SDK; cross-posting concurrency + politeness belong to the Plan 4 pipeline (`p-limit`), not the scorer.

## Global Constraints

- **Inherit Plans 1–2 constraints:** TypeScript strict ESM, no `any`, no non-null `!`, `node:`-prefixed core imports, extensionless relative imports + `@app/*` alias, colocated `*.test.ts`, Biome-clean (double quotes, 2-space, 100 width), Conventional Commits.
- **No live network in the automated suite.** Every unit that talks to Claude takes an `LlmClient`. Tests pass a `FakeLlmClient` returning canned payloads or throwing. The real SDK-backed `AnthropicLlmClient` is the production default and is exercised only by the opt-in smoke script (Task 6).
- **Validate the model payload with zod.** A payload that fails its schema is treated exactly like an API failure: degrade to the heuristic and emit a `Warning` — never a thrown error that aborts scoring.
- **Degrade, never crash.** No key, API error, refusal, or malformed payload → heuristic `MatchResult` + a `Warning`. `LlmScorer.score` never rejects.
- **`Scorer` interface unchanged.** `score(profile, posting): MatchResult | Promise<MatchResult>` stays as-is; `HeuristicScorer` is untouched. Warnings flow through an injected `onWarning?` callback.
- **No secrets in code or fixtures.** The smoke script reads the key from `ANTHROPIC_API_KEY`; no key is ever committed.

---

### Task 1: API key & model resolution

**Files:**
- Create: `src/matching/resolve-settings.ts`
- Test: `src/matching/resolve-settings.test.ts`

**Interfaces:**
- Consumes: a structural `SettingsReader` = `{ getSetting(key: string): string | undefined }` (satisfied by `Repository`).
- Produces:
  - `API_KEY_SETTING = "anthropicApiKey"`, `MODEL_SETTING = "scorerModel"`, `DEFAULT_SCORER_MODEL = "claude-sonnet-4-6"` (exported constants).
  - `resolveApiKey(settings: SettingsReader): string | undefined` — returns the trimmed key, or `undefined` when unset/blank.
  - `resolveScorerModel(settings: SettingsReader): string` — returns the configured model or `DEFAULT_SCORER_MODEL`.

**Contract:**
- A `settings` stub returning a key yields that key (trimmed); a whitespace-only or absent value yields `undefined`.
- `resolveScorerModel` returns the stored value when present, else `DEFAULT_SCORER_MODEL`.

- [ ] **Step 1:** failing test against a fake `SettingsReader` (and a round-trip through a temp `Repository` to prove the `settings` table wiring).
- [ ] **Step 2:** run → fails (module not found).
- [ ] **Step 3:** implement the two pure resolvers + constants.
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5:** commit — `feat: resolve anthropic api key and scorer model from settings`.

---

### Task 2: LLM client seam + match payload schema

**Files:**
- Create: `src/matching/llm-client.ts`
- Create: `src/matching/llm-schema.ts`
- Test: `src/matching/llm-client.test.ts` (covers `FakeLlmClient` + the schema; `AnthropicLlmClient` is covered by the smoke script, like `HttpFetcher`)

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

**Contract:**
- `MatchPayloadSchema` accepts a well-formed payload and rejects ones with a missing field, an out-of-range `score`, or wrong types.
- `FakeLlmClient` returns its canned payload for any request; the error-configured variant rejects.

- [ ] **Step 1:** add `@anthropic-ai/sdk` (`npm install @anthropic-ai/sdk`, pin the resolved version in `package.json`); write the failing schema + `FakeLlmClient` test.
- [ ] **Step 2:** run → fails (module not found).
- [ ] **Step 3:** implement `llm-schema.ts` and `llm-client.ts`. Keep all SDK-specific config (model, thinking, effort, cache_control, `parse`) inside `AnthropicLlmClient`.
- [ ] **Step 4:** run → PASS; `npm run typecheck` clean against the SDK types.
- [ ] **Step 5:** commit — `feat: add injectable anthropic llm client seam and match payload schema`.

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
- Consumes: `resolveApiKey`/`resolveScorerModel` (Task 1), `AnthropicLlmClient` (Task 2), `LlmScorer` (Task 4), `HeuristicScorer` (Plan 1), `Warning`.
- Produces:
  - `type ResolveScorerDeps = { settings: SettingsReader; dictionary?: string[]; onWarning?: (w: Warning) => void; llmClientFactory?: (opts: { apiKey: string; model: string }) => LlmClient }` — `llmClientFactory` defaults to `(opts) => new AnthropicLlmClient(opts)` and is injectable so the factory itself is testable with a `FakeLlmClient`.
  - `resolveScorer(deps: ResolveScorerDeps): Scorer`:
    - no key → emit one `Warning` (`source: "llm-scorer"`, "no API key configured; using the free heuristic scorer") and return `new HeuristicScorer(dictionary)`.
    - key present → return `new LlmScorer(llmClientFactory({ apiKey, model }), new HeuristicScorer(dictionary), onWarning)`.

**Contract:**
- A `settings` stub with no key → returns a `HeuristicScorer` and fires the no-key `Warning` once.
- A `settings` stub with a key + an injected `llmClientFactory` → returns an `LlmScorer`; scoring a posting routes through the fake client (assert the rationale appears), and the resolved model equals the `scorerModel` setting (assert the factory received it).

- [ ] **Step 1:** failing test for both branches with stubs + an injected `llmClientFactory`.
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
- API-key resolution in one testable place → `resolveApiKey` (Task 1) + `resolveScorer` (Task 5). Resolution source is the `settings` table (the Plan 5 UI writes the key; Plan 4 adds keychain storage). The spec's baked-in-key tier is **deferred** — see Out of scope. ✅
- No real tokens spent in tests; mocked client proves both the success path and the error→heuristic fallback → `FakeLlmClient` across Tasks 2–5; live path only in the Task 6 smoke script. ✅
- Validate external data with zod → `MatchPayloadSchema` at the boundary (Tasks 2, 4). ✅

**Boundary with Plans 1–2:** consumes `Scorer`, `MatchResult`, `SkillProfile`, `JobPosting`, `Warning`, `HeuristicScorer`, and `Repository`'s `getSetting` unchanged. Produces new units `LlmClient`/`AnthropicLlmClient`/`FakeLlmClient`, `LlmScorer`, the pure prompt/mapping helpers, and the `resolveApiKey`/`resolveScorerModel`/`resolveScorer` resolvers. No changes to existing domain types or the `Scorer` interface.

**Out of scope (later plans):**
- The baked-in author's-key tier and OS-keychain storage of the key → Plan 4/5 (the headless layer reads whatever the UI persisted into `settings`; encryption-at-rest and the build-time key live with the Electron main process).
- Wiring `resolveScorer` into the discovery→matching→freshness→storage pipeline, concurrency/politeness for many-posting scoring runs, and streaming progress → Plan 4.
- The Settings UI for entering the key and choosing the model → Plan 5.
- Prompt-cache pre-warming and any batching/cost dashboards → deferred (caching breakpoint is wired in Task 2 but not pre-warmed).

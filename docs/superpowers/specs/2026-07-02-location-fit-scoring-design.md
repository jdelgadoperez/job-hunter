# Location-fit deep-scoring (home country + accurate remote/hybrid) — Design

## Context

Two related problems waste deep-score tokens and pollute the ranking with non-starters:

1. **Overseas roles rank high and cost tokens.** A user in the US sees on-site roles in other
   countries deep-scored (spending Anthropic budget) and ranked highly, when they're non-starters.
2. **Hybrid roles are mis-flagged as Remote.** Example: a SafeLease "Full Stack Software Engineer",
   Location "ATX OR NYC", **Location Type: Hybrid**, is tagged **Remote** by job-hunter. Because the
   country gate (below) keeps "remote" roles, a hybrid mis-flagged as remote slips through the filter
   *and* ranks high — the exact leak the country feature is meant to close.

These are one concern — *does this role's location fit where I can actually work* — so they ship
together. Problem 2 is a prerequisite for problem 1's fix to be correct.

### Root cause of the hybrid bug (confirmed)

`resolvePostingRemote` (`src/matching/remote-filter.ts:20`) trusts a posting's structured `remote`
flag when present, else falls back to a free-text regex. The connectors set that flag:

- **Lever** (`lever.ts:9`): `workplaceType === "remote"` → correct; Hybrid → `false`. ✅
- **Rippling** (`rippling.ts:36-38`): only `"REMOTE"` → true; hybrid/on-site → `false`. ✅
- **Ashby** (`ashby.ts:21`): `remote: job.isRemote` → **BUG.** Ashby's `isRemote` is `true` for both
  Remote *and* Hybrid location types, so hybrids arrive as `remote: true`. ❌
- **Greenhouse / Workday / browser fallback**: don't set `remote`; they fall back to the free-text
  regex `/\b(remote|anywhere|distributed|work from home|wfh)\b/i`, which does NOT match "Hybrid" — so
  no false positive there, though a location like "ATX OR NYC" correctly yields `false`.

Ashby is the outlier. **Confirmed against a live Ashby response** (SafeLease board, the exact company
from the bug report, 2026-07-02): every job carries a `workplaceType` field with values `"OnSite"`,
`"Remote"`, or `"Hybrid"`, and **every Hybrid role has `isRemote: true`** — e.g. "Full Stack Software
Engineer" · location "ATX OR NYC" · `isRemote: true` · `workplaceType: "Hybrid"` (the screenshot
role). So `workplaceType` is the authoritative signal; the correct mapping is
`remote: workplaceType === "Remote"` (note the value is `"OnSite"`, no hyphen, not `"On-site"`). The
committed fixture (`__fixtures__/ashby.json`) predates the remote work and has neither field, so it
must be refreshed with a real hybrid example as part of the fix.

## Scope decisions (from brainstorming)

- **Home country** is detected from the resume and editable in Settings; blank = feature off (no-op).
- **Exclusion rule**: exclude from deep-scoring only roles with a **known** country ≠ home country
  **and** not remote. In-country, remote, and unknown-country roles are always kept (never guess/drop).
- **Excluded roles** get a penalized heuristic score (ranked low, no LLM tokens) — reusing the
  existing remote-penalty pattern.
- **Composition**: the country gate and the existing remote-only gate are independent; a role must
  pass both active gates to be deep-scored. A role excluded by either is penalized.
- **Hybrid fix folded in**: accurate remote/hybrid detection is part of this feature (it makes the
  gate correct).

## Design

### 1. Fix Ashby remote/hybrid detection (`connectors/schemas.ts`, `connectors/ashby.ts`)

- Add `workplaceType: z.string().optional()` to `AshbyJob` (`schemas.ts:38-46`).
- In `ashby.ts`, replace `remote: job.isRemote` with a helper mirroring `leverRemote`:
  prefer `workplaceType` when present (`remote: workplaceType === "Remote"`), else fall back to
  `isRemote`. `"Hybrid"` / `"OnSite"` → `false`. Extract as `ashbyRemote(workplaceType, isRemote)`
  for testing. (Values confirmed live: `"OnSite"` | `"Remote"` | `"Hybrid"`.)
- Refresh `__fixtures__/ashby.json` with a real hybrid job (from the SafeLease probe) so the
  connector test exercises the actual shape.
- Lever and Rippling are already correct — no change; a regression test documents the contract.
- Net effect: `resolvePostingRemote` becomes trustworthy for Ashby-sourced hybrids.

### 2. Home-country setting + resume detection

- New setting `homeCountry` (`settings-keys.ts`: `HOME_COUNTRY_SETTING = "homeCountry"`). Value is a
  canonical country label from `parseCountry` ("US", "UK", "Canada", "India", …). Blank/unset = no-op.
- New resolver `resolveHomeCountry(settings): string | undefined` (`resolve-settings.ts`) — trimmed
  stored value or `undefined`.
- **Resume detection**: at profile-build time (`buildProfile` is called from the CLI `profile`
  command and the server resume-upload path), run the resume text through `parseCountry` and, **only
  when `homeCountry` is unset**, store the detected value as the setting. Never overwrite a
  user-provided value. Detection failure → leave unset (feature stays off until the user sets it).
  This depends on `parseCountry`; if the country-parsing feature (separate branch) is merged first,
  detection is more accurate, but this feature does not require it.
- Surfaced in the dashboard **Settings** tab as a "Home country" text input (canonical label),
  editable, with a hint that it filters/penalizes clearly-foreign on-site roles.

### 3. `resolvePostingCountry` + `isOffCountryNonStarter` (`src/matching/location-filter.ts`)

Mirror `resolvePostingRemote`:

```
resolvePostingCountry(posting): string | undefined
  → posting.country if present, else parseCountry(posting.location)

isOffCountryNonStarter(posting, homeCountry): boolean
  → homeCountry !== undefined
    AND resolvePostingCountry(posting) is a KNOWN country (!== undefined)
    AND that country !== homeCountry
    AND NOT resolvePostingRemote(posting)
```

Unknown-country → not a non-starter (kept). Remote → not a non-starter (kept). This is the single
predicate the score-run partition uses.

### 4. Independent partition in `score-run.ts`

Extend the existing remote-only partition (`score-run.ts:86-123`). Today it splits `gated` into
`afterRemote` (LLM path) and `nonRemotePenalized` (penalized, no LLM) when `remoteOnly` is on. Add a
second, independent split by `isOffCountryNonStarter(posting, homeCountry)`:

- A candidate reaches the LLM path only if it is **not** filtered by the remote-only gate (when on)
  **and not** an off-country non-starter (when `homeCountry` set).
- Off-country non-starters join the penalized-heuristic set: saved with a penalized score and a
  location tag, exactly once (idempotent), respecting the cap — the same treatment non-remote roles
  get under remote-only.

`homeCountry` is threaded into `ScoreOptions` (resolved from settings by the score-runner, like the
scorer model), so `runScoreRun` stays pure and DI-testable.

### 5. Penalty tag + helper (`heuristic-scorer.ts`, `repository.ts`)

- Generalize the penalty. Add `applyLocationPenalty(result)` (or reuse `applyRemotePenalty` with a
  shared factor) — a pure multiply-and-clamp like `applyRemotePenalty` (`REMOTE_PENALTY_FACTOR = 0.6`).
  Decision: **reuse `applyRemotePenalty`** (same 0.6 factor; "location non-starter" and "non-remote"
  deserve the same demotion) to avoid a second constant, unless review prefers a distinct factor.
- Add a `ScorerTag` member for the new case: `"heuristic-location-penalized"` (extend the union at
  `repository.ts:40` and `normalizeScorerTag` at `:64`). A distinct tag (vs. reusing
  `heuristic-remote-penalized`) keeps the idempotency guard precise — a location-penalized row isn't
  re-penalized, and the two reasons stay distinguishable in the store/UI.
- A posting excluded by BOTH gates (foreign AND non-remote under remote-only) is penalized once;
  pick a deterministic single tag (location takes precedence, since it's the stronger signal), penalty
  applied once — no double reduction.

### 6. Matches UI (minor)

- Excluded foreign roles already appear (penalized, ranked low) — no new list plumbing needed.
- Optional, low-priority: a small badge distinguishing "off-country" from the existing "Unknown
  location" badge, using the home-country setting. Flagged as nice-to-have, not required.

## Testing (TDD, colocated, offline, gate 93/85/90/93)

- `ashby` connector test: a job with `workplaceType: "Hybrid"` + `isRemote: true` maps to
  `remote: false`; `"Remote"` → `true`; `"On-site"` → `false`; absent `workplaceType` falls back to
  `isRemote`. Plus a `lever`/`rippling` regression test asserting Hybrid → `false` (contract lock).
- `location-filter` test: `resolvePostingCountry` (structured field wins over parse);
  `isOffCountryNonStarter` truth table — in-country→false, foreign+onsite→true, foreign+remote→false,
  unknown→false, no-homeCountry→false.
- `resolve-settings` test: `resolveHomeCountry` from setting else undefined.
- Profile-build test: resume text with a US address pre-fills `homeCountry` when unset; does NOT
  overwrite an existing setting; undetected → left unset.
- `score-run` test: with `homeCountry` set, a foreign on-site candidate is excluded from the LLM path
  and saved `heuristic-location-penalized` with a reduced score; a foreign remote candidate and an
  unknown-country candidate reach the LLM path; idempotent (a location-penalized row isn't
  re-penalized); composes with remoteOnly (a role failing either gate is penalized once, single tag).
- Cost/preview test: the deep-score preview count reflects the exclusion (fewer titles to score →
  fewer tokens), proving the token-saving.

## Non-goals / flags

- No city→country gazetteer (relies on `parseCountry`'s explicit signals; unknown stays kept).
- No new dependency.
- Home country is a single country label, not a list/region (YAGNI; revisit if multi-country needed).
- The double-gate single-penalty rule (location precedence) is a deliberate, tested choice.
- Depends conceptually on `resolvePostingRemote` accuracy — hence the Ashby fix ships in this spec.
- Interacts with but is independent of the country-parsing and incremental-scan features (separate
  branches); better `parseCountry` improves detection but isn't required.

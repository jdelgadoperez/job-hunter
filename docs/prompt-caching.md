# Prompt caching in the LLM `score` step

The `score` command makes two kinds of Anthropic API calls — **batch title triage**
(`triage-client.ts`) and **deep scoring** (`llm-client.ts`). Both are structured so the *stable*
part of the prompt is reused across calls and the *volatile* part is not:

| Block | Content | Per call | Cached? |
| --- | --- | --- | --- |
| `system` | scoring/triage instructions **+** your serialized skill profile | byte-identical across a run | **yes** — `cache_control: { type: "ephemeral" }` |
| `user` | the job title + description (deep score) or the batch of titles (triage) | unique each call | no — it's the volatile part |

This is the correct shape: the only content worth caching is the part that repeats, and that part is
already marked. **The `cache_control` marker has been in place since the triage/deep-score split** —
low cache utilization is *not* a missing-marker problem.

## Why the hit rate can still read as ~0%

Anthropic prompt caching only engages when the cached prefix meets a **minimum cacheable size**:

| Model | Minimum cacheable prefix |
| --- | --- |
| Sonnet 4.6 / Fable 5 | 2048 tokens |
| Opus 4.8 / 4.7 / 4.6, Haiku 4.5 | 4096 tokens |

If the cached `system` block is **below** that threshold, the marker is **silently a no-op**: the API
returns `cache_creation_input_tokens: 0` and `cache_read_input_tokens: 0`, and you pay full price on
every call with nothing cached.

job-hunter's default model is `claude-sonnet-5` (see `llm-providers.ts`), so the prefix must clear
**2048 tokens** to cache at all. The cached prefix is just the instructions (~200 tokens) plus your
serialized profile (skills / role keywords / categories — typically a few hundred tokens). For most
profiles that total is **well under 2048 tokens**, so caching never engages. That is the most likely
explanation for a low cache hit rate on this app specifically.

The flip side: the *expensive* tokens in a deep score are the **job description**, which is unique per
posting and therefore inherently uncacheable. So even when the prefix does cross the threshold, the
savings are bounded by how big the shared prefix is — they don't touch the per-posting body.

## How to measure it

`score` now prints a usage summary after the plan (skipped on `--dry-run`, which makes no calls):

```
LLM usage over 37 call(s): 41234 input + 5120 output tokens
  prompt caching did not engage — the cached system prefix is below the model's minimum
  cacheable size (Sonnet 4.6 = 2048 tokens; Opus 4.x / Haiku 4.5 = 4096) ...
```

or, when caching is working:

```
LLM usage over 37 call(s): 41234 input + 5120 output tokens
  prompt cache: 38000 read + 1120 written (97% of cacheable input served from cache)
```

The numbers come straight from each call's `response.usage`
(`cache_read_input_tokens` / `cache_creation_input_tokens`), accumulated in
`UsageAccumulator` (`llm-usage.ts`). Run a real `score` (not `--dry-run`) against a populated DB to
see the actual behavior for your profile and model.

## What's worth doing — and what isn't

- **Measure first (done).** The usage summary turns "is caching working?" into a number. Check it on a
  real run before changing anything.
- **Don't pad the prefix to cross the threshold.** Inflating the system block with filler just to
  reach 2048 tokens would *cost* tokens on the first (cache-write) call and save only the small,
  genuinely-shared prefix on later calls — a net loss for a per-run scan that may not even reuse the
  5-minute cache TTL.
- **The TTL is 5 minutes.** Within one `score` run the triage batches and deep scores happen close
  together, so a cached prefix (if it crosses the threshold) is reused across that run. Across
  *separate* runs spaced more than a few minutes apart, the cache has expired — caching helps within a
  run, not between occasional runs.
- **Org-wide savings are likely elsewhere.** An "up to N% of API spend" cache estimate is computed
  across *all* of an org's traffic. job-hunter's repeated content is a small prefix against large
  unique descriptions, so its own caching headroom is modest; the bulk of any org-wide caching win
  usually comes from higher-volume, larger-shared-prefix workloads.

## Where this lives in the code

- `src/matching/llm-client.ts` / `triage-client.ts` — apply `cache_control` and emit per-call usage
  via an optional `onUsage` callback.
- `src/matching/llm-usage.ts` — `toLlmUsage` (normalize the SDK fields), `UsageAccumulator`, and
  `formatUsageSummary` (the printed line).
- `src/cli/main.ts` (`runScore`) — accumulates usage from both steps and prints the summary.

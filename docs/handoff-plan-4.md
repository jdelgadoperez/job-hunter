# Handoff — continue locally (ATS connector expansion)

Paste the prompt below into a fresh local Claude Code session, or just point the
session at this file. Written for a **local** machine with open network access
(the prior web session was egress-blocked from `ats.rippling.com`).

---

I'm continuing the job-hunter repo (jdelgadoperez/job-hunter) locally. A prior
Claude Code web session built it up through several merged PRs; I'm taking over
on my machine, which (unlike the web session) has open network access. Orient
yourself, then work the tasks below.

## Setup
- Sync first: `git checkout main && git pull`. PRs #29–#34 are all merged.
  Ignore any stale web-session branch.
- Project: headless job-hunting engine, TypeScript strict ESM, Node 22 (see
  `.nvmrc`). Scripts: `npm run lint` (biome), `npm run typecheck` (tsc),
  `npm test` (vitest). Run all three green before every commit.
- Conventions: no `any` / non-null `!`, `node:`-prefixed core imports,
  extensionless relative imports + `@app/*` alias, colocated `*.test.ts`,
  Conventional Commits, NO live network in tests (inject `FakeFetcher`, validate
  all external JSON with zod). Develop on a feature branch off `main`, commit
  incrementally, push, open a **draft PR**.

## How ATS connectors work (`src/discovery/`)
- Each connector implements `AtsConnector` (`connectors/types.ts`): a `source` +
  a `fetchPostings(boardToken, fetcher)`.
- Simple JSON-feed connectors (greenhouse/lever/ashby) delegate to the shared
  `fetchAtsPostings` helper (`connectors/ats-feed.ts`) — they supply only the
  URL, a zod schema (`connectors/schemas.ts`), how to reach the jobs array, and a
  per-field map. Read `connectors/ashby.ts` — it's ~20 lines.
- Workday is a list+detail connector (paginated list, then a per-job detail fetch
  for the full description). Read `connectors/workday.ts`.
- Routing: `resolve-ats.ts` maps a careers-URL hostname → connector. Register new
  connectors in `connectors/registry.ts` (and `connectorBySource` there if the
  board token is re-derivable, for liveness re-checks).
- Tests: `FakeFetcher` + JSON fixtures in `connectors/__fixtures__/`, one
  `*.test.ts` per connector. Unmatched hosts fall back to the generic browser
  connector.

## Task 1 — prioritized connector backlog
Run `npm run analyze:directory`. It reports the directory companies grouped by
ATS platform, including which platforms have NO connector yet (currently
everything except Greenhouse/Lever/Ashby/Workday falls back to the slow browser
scraper). Produce a ranked list of un-covered ATS platforms by company count —
that's the connector backlog. Show it to me before building beyond Rippling.

## Task 2 — Rippling ATS connector (first off the backlog)
Public API, no auth:
- list: `GET https://ats.rippling.com/api/v2/board/{slug}/jobs?page=&pageSize=`
  → `{ totalItems, totalPages, items: [...] }` (title/dept/location, but **no
  description** in the list)
- detail: a separate per-job request returns the full HTML description.

EXACT field names are **unverified** — the web session was egress-blocked from
`ats.rippling.com`. Your machine isn't, so **first capture the real shape**:

```sh
curl -sS "https://ats.rippling.com/api/v2/board/just-appraised-jobs/jobs?page=0&pageSize=2"
```

Confirm the list fields, the detail-endpoint URL format, and the description
field before writing the zod schema. Save the real responses as fixtures.
Build it as a list+detail connector mirroring Workday: schema in `schemas.ts`,
host routing in `resolve-ats.ts`, registration in `registry.ts`, `*.test.ts`
with `FakeFetcher` + captured fixtures. Lint/typecheck/test green, draft PR.

## Outstanding ideas (discuss/prioritize first — don't auto-build)
- More ATS connectors: work down the `analyze:directory` backlog from Task 1
  (likely SmartRecruiters, Workable, etc. — confirm from real output).
- Anything the directory analysis flags as a large un-covered cluster.

For each new platform, follow the same recipe: verify the live API shape with
`curl`, then mirror the simplest matching existing connector (feed vs.
list+detail).

Start with Task 1 so we're prioritizing from real numbers, then do Task 2.

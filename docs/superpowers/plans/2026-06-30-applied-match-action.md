# Applied Match Action Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `applied` user action that hides a posting from the default Matches list but stays revealable via a "Show applied" toggle and an "Applied (N)" filter view.

**Architecture:** Pure enum extension of the existing single-action `user_actions` machinery — no schema change. `UserAction` gains `"applied"`; `listScoredPostings` hides it by default with two new options (`includeApplied` to reveal inline, `onlyApplied` to show only applied); `/api/matches` exposes both; the dashboard gets a "Mark applied" button, a "Show applied" toggle, and an "Applied (N)" filter mode.

**Tech Stack:** TypeScript (strict, ESM), better-sqlite3, Hono, React 19 + TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-30-applied-match-action-design.md`

**Base:** branch `feat/applied-match-action`, stacked on `feat/matches-remote-country-filters` (PR #78).

## Global Constraints

- TypeScript-strict, ESM, ES2022; `noUncheckedIndexedAccess`, `noImplicitOverride` on.
- **No `!` non-null assertions. No type assertions outside tests.**
- No new runtime dependencies.
- Biome: 2-space, 100-col, double quotes. **Verify lint with the exact CI command `npm run lint` (`biome check .`) at full project scope — never a file subset.**
- Tests colocated, offline, fixture-driven. Coverage gate stays green: statements 92 / branches 85 / functions 90 / lines 93.
- **Failures degrade, never crash.** `/api/matches` params are lenient (absent/other ⇒ false). The action-write endpoint validates and 400s on an unknown action (preserved).
- A posting with no action (`ua.action IS NULL`) always shows — every hide clause must keep the `IS NULL` guard.
- `onlyApplied` wins over `includeApplied`/`includeDismissed` when both are set.
- Single-action model unchanged: `applied` replaces any prior action (PK `posting_id`).
- Conventional Commits. **No Claude co-authored footer.**

## File Structure

- `src/storage/repository.ts` (modify) — `UserAction` type; `ListMatchesOptions` (+`includeApplied`, `onlyApplied`); `listScoredPostings` WHERE clause.
- `src/server/app.ts` (modify) — action-write guard (+`applied`); `/api/matches` reads the two new params.
- `web/src/api.ts` (modify) — `UserAction` (+`applied`); `MatchFilters` (+`includeApplied`, `onlyApplied`); `getMatches` query params.
- `web/src/hooks.ts` (modify) — `useMatches` query key includes the new flags.
- `web/src/views/Matches.tsx` (modify) — "Mark applied" button; "Show applied" toggle; "Applied (N)" filter mode.

---

## Task 1: `UserAction` gains `applied` + repository filtering

**Files:**
- Modify: `src/storage/repository.ts` (`UserAction` line ~10; `ListMatchesOptions` ~21; `listScoredPostings` ~191-216)
- Test: `src/storage/repository.test.ts`

**Interfaces:**
- Produces: `UserAction = "saved" | "dismissed" | "applied"`; `ListMatchesOptions` gains `includeApplied?: boolean` and `onlyApplied?: boolean`; `listScoredPostings` hides `applied` by default, reveals with `includeApplied`, shows only applied with `onlyApplied`.

- [ ] **Step 1: Write the failing tests**

Append to `src/storage/repository.test.ts` (the file already has a `seedWithCountry`-style helper pattern; add a local helper for actions):

```ts
describe("listScoredPostings — applied action", () => {
  function seedWithAction(repo: Repository, id: string, score: number, action?: UserAction): void {
    repo.savePosting({ ...posting, id });
    repo.saveMatchResult(id, { score, matchedSkills: [], missingSkills: [] });
    if (action) repo.setUserAction(id, action);
  }

  it("hides applied postings by default", () => {
    const repo = newRepo();
    seedWithAction(repo, "p-applied", 90, "applied");
    seedWithAction(repo, "p-none", 80);
    const ids = repo.listScoredPostings(0).map((s) => s.posting.id);
    expect(ids).toEqual(["p-none"]);
    repo.close();
  });

  it("reveals applied postings with includeApplied", () => {
    const repo = newRepo();
    seedWithAction(repo, "p-applied", 90, "applied");
    seedWithAction(repo, "p-none", 80);
    const ids = repo.listScoredPostings(0, { includeApplied: true }).map((s) => s.posting.id);
    expect(ids).toEqual(["p-applied", "p-none"]);
    repo.close();
  });

  it("onlyApplied returns just applied postings", () => {
    const repo = newRepo();
    seedWithAction(repo, "p-applied", 90, "applied");
    seedWithAction(repo, "p-saved", 80, "saved");
    seedWithAction(repo, "p-none", 70);
    const ids = repo.listScoredPostings(0, { onlyApplied: true }).map((s) => s.posting.id);
    expect(ids).toEqual(["p-applied"]);
    repo.close();
  });

  it("a no-action posting always shows (never dropped by the applied clause)", () => {
    const repo = newRepo();
    seedWithAction(repo, "p-none", 80);
    expect(repo.listScoredPostings(0).map((s) => s.posting.id)).toEqual(["p-none"]);
    repo.close();
  });

  it("setting applied replaces a prior saved (single-action model)", () => {
    const repo = newRepo();
    seedWithAction(repo, "p", 90, "saved");
    repo.setUserAction("p", "applied");
    // Default list hides it now (applied), and includeApplied shows action=applied.
    expect(repo.listScoredPostings(0).map((s) => s.posting.id)).toEqual([]);
    const [row] = repo.listScoredPostings(0, { includeApplied: true });
    expect(row?.action).toBe("applied");
    repo.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/storage/repository.test.ts`
Expected: FAIL — `applied` not accepted by `UserAction` (type) and not hidden/filtered by the query.

- [ ] **Step 3: Implement**

In `src/storage/repository.ts`, extend the type (line ~10):

```ts
export type UserAction = "saved" | "dismissed" | "applied";
```

Extend `ListMatchesOptions` (line ~21):

```ts
export type ListMatchesOptions = {
  includeExpired?: boolean;
  includeDismissed?: boolean;
  remoteOnly?: boolean;
  country?: string;
  includeApplied?: boolean;
  onlyApplied?: boolean;
};
```

In `listScoredPostings`, replace the action portion of the WHERE clause. The current clause is:

```ts
         WHERE m.score >= ?${opts.includeExpired ? "" : " AND p.expired_at IS NULL"}${
           opts.includeDismissed ? "" : " AND (ua.action IS NULL OR ua.action != 'dismissed')"
}${countrySql}
```

Replace the `includeDismissed` line and add the applied handling. Build the action clause separately above the query for clarity:

```ts
    // Action visibility. onlyApplied is an explicit "show me what I applied to" view and overrides
    // the default hides. Otherwise dismissed and applied are each hidden unless their include flag is
    // set. Every clause keeps the `ua.action IS NULL` guard so a no-action posting always shows.
    let actionSql: string;
    if (opts.onlyApplied) {
      actionSql = " AND ua.action = 'applied'";
    } else {
      const hideDismissed = opts.includeDismissed
        ? ""
        : " AND (ua.action IS NULL OR ua.action != 'dismissed')";
      const hideApplied = opts.includeApplied
        ? ""
        : " AND (ua.action IS NULL OR ua.action != 'applied')";
      actionSql = `${hideDismissed}${hideApplied}`;
    }
```

Then use `actionSql` in the query in place of the old inline `includeDismissed` ternary:

```ts
         WHERE m.score >= ?${opts.includeExpired ? "" : " AND p.expired_at IS NULL"}${actionSql}${countrySql}
```

(Leave the `countrySql`, params array, SELECT, and row mapping from PR #78 untouched.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/storage/repository.test.ts`
Expected: PASS (all existing + 5 new).

- [ ] **Step 5: Lint (full scope) + typecheck + commit**

```bash
npm run lint
npm run typecheck
git add src/storage/repository.ts src/storage/repository.test.ts
git commit -m "feat(storage): add applied action with includeApplied/onlyApplied filtering"
```

---

## Task 2: action-write guard + `/api/matches` params

**Files:**
- Modify: `src/server/app.ts` (`/api/matches` handler ~78-91; action PUT guard ~94-101)
- Test: `src/server/app.test.ts`

**Interfaces:**
- Consumes: `listScoredPostings` options `includeApplied`/`onlyApplied` (Task 1).
- Produces: `PUT /api/matches/:id/action` accepts `"applied"`; `GET /api/matches` reads `includeApplied` and `onlyApplied`.

- [ ] **Step 1: Write the failing tests**

Append to `src/server/app.test.ts` (match the existing `app.request` + in-memory repo pattern):

```ts
describe("applied action API", () => {
  it("accepts applied on the action endpoint", async () => {
    const { app, repo } = makeApp();
    repo.savePosting({ ...samplePosting, id: "a1" });
    repo.saveMatchResult("a1", { score: 90, matchedSkills: [], missingSkills: [] });
    const res = await app.request("/api/matches/a1/action", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "applied" }),
    });
    expect(res.status).toBe(200);
    // Hidden by default, visible with includeApplied.
    const def = await json<unknown[]>(await app.request("/api/matches?minScore=0"));
    expect(def).toHaveLength(0);
    const shown = await json<unknown[]>(
      await app.request("/api/matches?minScore=0&includeApplied=true"),
    );
    expect(shown).toHaveLength(1);
  });

  it("rejects an unknown action", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/matches/x/action", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "bogus" }),
    });
    expect(res.status).toBe(400);
  });

  it("onlyApplied returns just applied postings", async () => {
    const { app, repo } = makeApp();
    repo.savePosting({ ...samplePosting, id: "ap" });
    repo.saveMatchResult("ap", { score: 90, matchedSkills: [], missingSkills: [] });
    repo.setUserAction("ap", "applied");
    repo.savePosting({ ...samplePosting, id: "no" });
    repo.saveMatchResult("no", { score: 80, matchedSkills: [], missingSkills: [] });
    const only = await json<{ posting: { id: string } }[]>(
      await app.request("/api/matches?minScore=0&onlyApplied=true"),
    );
    expect(only.map((s) => s.posting.id)).toEqual(["ap"]);
  });
});
```

(Use the test file's existing app/repo factory and `json<T>` helper — read the top of `app.test.ts` to match the exact names, e.g. `makeApp`, `samplePosting`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/server/app.test.ts`
Expected: FAIL — `applied` rejected by the guard; params not read.

- [ ] **Step 3: Implement**

In `src/server/app.ts`, the `/api/matches` handler — add the two params and pass them through:

```ts
      repo.listScoredPostings(minScore, {
        includeExpired: c.req.query("includeExpired") === "true",
        includeDismissed: c.req.query("includeDismissed") === "true",
        remoteOnly: c.req.query("remoteOnly") === "true",
        country,
        includeApplied: c.req.query("includeApplied") === "true",
        onlyApplied: c.req.query("onlyApplied") === "true",
      }),
```

The action PUT guard — accept `applied` and update the message:

```ts
    if (body?.action !== "saved" && body?.action !== "dismissed" && body?.action !== "applied") {
      return c.json({ error: 'expected { "action": "saved" | "dismissed" | "applied" }' }, 400);
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/server/app.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + typecheck + commit**

```bash
npm run lint
npm run typecheck
git add src/server/app.ts src/server/app.test.ts
git commit -m "feat(api): accept applied action and includeApplied/onlyApplied on /api/matches"
```

---

## Task 3: web types + query key

**Files:**
- Modify: `web/src/api.ts` (`UserAction` ~25; `MatchFilters` ~30s; `getMatches` ~106)
- Modify: `web/src/hooks.ts` (`useMatches` query key ~8-13)

**Interfaces:**
- Consumes: the API params from Task 2.
- Produces: web `UserAction` includes `"applied"`; `MatchFilters` gains `includeApplied?`/`onlyApplied?`; `getMatches` forwards them; query key includes them.

- [ ] **Step 1: Implement (typecheck:web is the gate — no unit test for api.ts)**

In `web/src/api.ts`:

```ts
export type UserAction = "saved" | "dismissed" | "applied";
```

Extend `MatchFilters`:

```ts
export type MatchFilters = {
  includeExpired?: boolean;
  includeDismissed?: boolean;
  remoteOnly?: boolean;
  country?: string;
  includeApplied?: boolean;
  onlyApplied?: boolean;
};
```

In `getMatches`, after the existing conditional param sets:

```ts
    if (filters.includeApplied) params.set("includeApplied", "true");
    if (filters.onlyApplied) params.set("onlyApplied", "true");
```

In `web/src/hooks.ts`, add the two flags to the `useMatches` queryKey array (after `filters.country ?? ""`):

```ts
      filters.includeApplied ?? false,
      filters.onlyApplied ?? false,
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck:web`
Expected: passes.

- [ ] **Step 3: Lint + commit**

```bash
npm run lint
git add web/src/api.ts web/src/hooks.ts
git commit -m "feat(web/api): add applied to UserAction and includeApplied/onlyApplied filters"
```

---

## Task 4: dashboard — Mark applied button, Show applied toggle, Applied (N) filter

**Files:**
- Modify: `web/src/views/Matches.tsx`

**Interfaces:**
- Consumes: web `MatchFilters` + `UserAction` (Task 3); `useMatches` (Task 3 query key).

- [ ] **Step 1: Implement the "Mark applied" button in MatchCard**

In `MatchCard` (next to the existing Save/Dismiss buttons), add an Applied toggle mirroring the Save toggle. `applied` is the posting's action when set:

```tsx
        <Button
          variant="ghost"
          onClick={() =>
            setAction.mutate({ id: posting.id, action: action === "applied" ? null : "applied" })
          }
          className={action === "applied" ? "text-success" : ""}
        >
          {action === "applied" ? "✓ Applied" : "Mark applied"}
        </Button>
```

(Place it within the same button row as Save/Dismiss; match their `Button` usage exactly — read the surrounding JSX.)

- [ ] **Step 2: Add state, the "Show applied" toggle, and the "Applied (N)" mode**

In `Matches()`, add state next to the existing filter state:

```tsx
  const [includeApplied, setIncludeApplied] = useState(false);
  const [onlyApplied, setOnlyApplied] = useState(false);
```

Pass into the matches query (extend the existing `useMatches(...)` filters object):

```ts
  const matches = useMatches(minScore, {
    includeExpired,
    includeDismissed,
    remoteOnly,
    country,
    includeApplied,
    onlyApplied,
  });
```

Applied count — a lightweight onlyApplied query (mirrors the PR #78 country-options second query; TanStack dedupes by key):

```ts
  const appliedSource = useMatches(minScore, { onlyApplied: true });
  const appliedCount = appliedSource.data?.length ?? 0;
```

Render the controls in the filter row. "Applied (N)" is a distinct mode button (not a co-equal
checkbox) so the view is unambiguous; turning it on disables the inline "Show applied" toggle:

```tsx
        <button
          type="button"
          onClick={() => setOnlyApplied((v) => !v)}
          className={`rounded border px-2 py-0.5 text-sm ${
            onlyApplied ? "border-link bg-subtle text-fg" : "border-border text-muted"
          }`}
        >
          Applied ({appliedCount})
        </button>
        {!onlyApplied ? (
          <label className="flex items-center gap-1 text-sm text-muted">
            <input
              type="checkbox"
              checked={includeApplied}
              onChange={(e) => setIncludeApplied(e.target.checked)}
            />
            Show applied
          </label>
        ) : null}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck:web`
Then: `npm run build:web`
Expected: both pass.

- [ ] **Step 4: Lint + commit**

```bash
npm run lint
git add web/src/views/Matches.tsx
git commit -m "feat(web): mark-applied button, show-applied toggle, and applied filter view"
```

---

## Task 5: README + close-out

**Files:**
- Modify: `README.md` (the Matches dashboard bullet)

- [ ] **Step 1: Document the applied action**

In `README.md`, extend the **Matches** bullet (it already mentions Save/dismiss and the Remote/Country filters from PR #78) to add:

```md
  **Mark applied** to a role and it leaves the default list (like dismiss, but kept) — reveal them
  with **Show applied** or jump to the **Applied (N)** view to see everything you've applied to.
```

- [ ] **Step 2: Full CI**

```bash
npm run lint
npm run typecheck
npm run typecheck:web
npm run test:coverage
npm run build:web
```

Expected: all green, coverage above floors.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(matches): document the applied match action"
```

---

## Self-review notes

- **Spec coverage:** Task 1 (types + filtering), Task 2 (API guard + params), Task 3 (web types + key), Task 4 (button + toggle + filter view), Task 5 (docs) — every spec section maps to a task. `ignored` is correctly absent.
- **`onlyApplied` wins:** enforced in Task 1's `actionSql` (the `if (opts.onlyApplied)` branch ignores the include flags), and the UI hides the "Show applied" toggle when `onlyApplied` is on — consistent with the spec's collision rule.
- **No-action-always-shows:** every hide clause keeps `ua.action IS NULL OR ...`.
- **Type consistency:** `UserAction`, `includeApplied`, `onlyApplied` spelled identically across repository / app / web.

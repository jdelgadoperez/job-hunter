# Country Parsing (Explicit Signals) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover `country` for postings whose location contains an explicit place signal the current `parseCountry` misses (full state/province names, more country names, word-embedded signals), and backfill the existing DB — without ever guessing a bare city.

**Architecture:** Two units. (1) `src/matching/location-filter.ts` — expand the alias/state/province tables and add a whitespace word-level scan within each token, keeping whole-word exact matching. (2) `src/storage/repository.ts` `migrate()` — a one-time idempotent backfill that re-runs `parseCountry` over existing `country IS NULL` postings, mirroring the existing `companiesNeedingId` backfill.

**Tech Stack:** TypeScript-strict ESM, `better-sqlite3`, vitest (colocated `*.test.ts`, offline).

## Global Constraints

- TypeScript-strict, ESM. No type assertions; NEVER the `!` non-null assertion.
- No new dependencies — no city gazetteer, no geo-lookup library.
- **Never guess a country.** Only map high-confidence explicit signals; bare cities stay `undefined`.
- Canonical country labels: readable names ("India", "Spain") except existing ISO-2 "US"/"UK".
- Word matching is **whole-word exact** against the sets — never substring.
- Biome: 2-space indent, 100-col, double quotes. Run `./node_modules/.bin/biome check .` before commit (the harness prefers this over `npm run lint`).
- Coverage gate: statements 93 / branches 85 / functions 90 / lines 93.
- Conventional Commits. NO Claude co-authored footer.
- Do not hardcode magic values in `expect(...)` where a fixture reads better — EXCEPT this is a pure formatter/parser, so its literal input→output mappings ARE the contract and belong in `expect`.

---

### Task 1: Expand recognized signals in `parseCountry`

**Files:**
- Modify: `src/matching/location-filter.ts:10-36` (the `COUNTRY_ALIASES`, `US_STATES`, `CA_PROVINCES` tables)
- Test: `src/matching/location-filter.test.ts` (append cases to the existing table-driven suite)

**Interfaces:**
- Consumes: nothing new.
- Produces: `parseCountry(location?: string): string | undefined` — unchanged signature; broader recognition. Later tasks (backfill) call this exact function.

- [ ] **Step 1: Write failing tests for the new explicit signals**

Append these rows to the `cases` array in `src/matching/location-filter.test.ts` (inside the existing `describe("parseCountry")`, before the closing `]`):

```typescript
    // Full US state names → US
    ["Austin, Texas", "US"],
    ["Los Angeles, California", "US"],
    ["New York, New York", "US"],
    ["Seattle, Washington", "US"],
    // Full Canadian province names → Canada
    ["Vancouver, British Columbia", "Canada"],
    ["Toronto, Ontario", "Canada"],
    // New country aliases
    ["Bangalore, India", "India"],
    ["Dublin, Ireland", "Ireland"],
    ["Singapore, Singapore", "Singapore"],
    ["São Paulo, Brazil - Remote", "Brazil"],
    ["Barcelona, Spain", "Spain"],
    ["Mexico City, Mexico", "Mexico"],
    ["Amsterdam, Netherlands", "Netherlands"],
    ["Tokyo, Japan", "Japan"],
    ["Dubai, United Arab Emirates - Remote", "United Arab Emirates"],
    ["Ankara, Türkiye - Remote", "Türkiye"],
    ["Zurich, Switzerland", "Switzerland"],
    ["Bogotá, Colombia", "Colombia"],
    ["Sydney, Australia", "Australia"],
    // Bare cities and ambiguous strings STILL unknown (never guess)
    ["San Francisco", undefined],
    ["London", undefined],
    ["Barcelona", undefined],
    ["2 Locations", undefined],
    ["Home based - Worldwide", undefined],
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/matching/location-filter.test.ts`
Expected: FAIL — several cases (e.g. `"Austin, Texas" -> "US"`) fail because "texas" isn't recognized; `"Bangalore, India" -> "India"` fails because India isn't an alias. The existing passing cases and the `undefined` cases still pass.

- [ ] **Step 3: Add full US state names, full CA province names, and country aliases**

In `src/matching/location-filter.ts`, extend the three tables. Replace the `COUNTRY_ALIASES` object (lines 10-25) with:

```typescript
const COUNTRY_ALIASES: Record<string, string> = {
  us: "US",
  usa: "US",
  "u.s.": "US",
  "u.s.a.": "US",
  "united states": "US",
  "united states of america": "US",
  uk: "UK",
  "u.k.": "UK",
  "united kingdom": "UK",
  "great britain": "UK",
  canada: "Canada",
  germany: "Germany",
  deutschland: "Germany",
  france: "France",
  india: "India",
  ireland: "Ireland",
  singapore: "Singapore",
  australia: "Australia",
  brazil: "Brazil",
  brasil: "Brazil",
  spain: "Spain",
  españa: "Spain",
  mexico: "Mexico",
  méxico: "Mexico",
  netherlands: "Netherlands",
  japan: "Japan",
  switzerland: "Switzerland",
  colombia: "Colombia",
  "united arab emirates": "United Arab Emirates",
  uae: "United Arab Emirates",
  "türkiye": "Türkiye",
  turkey: "Türkiye",
};
```

Add full US state names to the US set. Replace the `US_STATES` definition (lines 28-33) with:

```typescript
// US: two-letter state codes AND full state names → US. (Lowercased.)
const US_STATES = new Set(
  (
    "al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj " +
    "nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc"
  ).split(" "),
);

// Full US state names (lowercased), mapped to US. Kept separate from the 2-letter codes so both
// "TX" and "Texas" resolve. "district of columbia" and "washington d.c." cover DC's full forms.
const US_STATE_NAMES = new Set(
  [
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut",
    "delaware", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa",
    "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan",
    "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire",
    "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma",
    "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee",
    "texas", "utah", "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming",
    "district of columbia", "washington d.c.",
  ],
);
```

Add full Canadian province names. Replace the `CA_PROVINCES` definition (lines 35-36) with:

```typescript
// Canada: province/territory codes AND full names → Canada. (Lowercased.)
const CA_PROVINCES = new Set("ab bc mb nb nl ns nt nu on pe qc sk yt".split(" "));

const CA_PROVINCE_NAMES = new Set(
  [
    "alberta", "british columbia", "manitoba", "new brunswick", "newfoundland and labrador",
    "nova scotia", "northwest territories", "nunavut", "ontario", "prince edward island",
    "quebec", "québec", "saskatchewan", "yukon",
  ],
);
```

- [ ] **Step 4: Consult the state-name and province-name sets in `parseCountry`**

In `parseCountry`, extend the per-token check (currently lines 52-60) so each token is also matched against the full-name sets. Replace the loop body's checks with:

```typescript
  // Check tokens from the end first — the country/region usually trails the city.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    if (token === undefined) continue;
    const key = normalizeToken(token);
    const alias = COUNTRY_ALIASES[key];
    if (alias !== undefined) return alias;
    if (US_STATES.has(key) || US_STATE_NAMES.has(key)) return "US";
    if (CA_PROVINCES.has(key) || CA_PROVINCE_NAMES.has(key)) return "Canada";
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/matching/location-filter.test.ts`
Expected: PASS for the state-name, province-name, and country-alias cases. Note: word-embedded cases like `"Remote US"` (no comma) may still fail here — those are Task 2. The multi-word "united arab emirates" passes because the split keeps "United Arab Emirates" as one token (no internal comma). `"Bare cities"` still `undefined`.

- [ ] **Step 6: Commit**

```bash
git add src/matching/location-filter.ts src/matching/location-filter.test.ts
git commit -m "feat(location): recognize full state/province names and more countries"
```

---

### Task 2: Word-level scan within tokens + `;` delimiter

**Files:**
- Modify: `src/matching/location-filter.ts` (the split regex on line ~46 and the matching loop from Task 1)
- Test: `src/matching/location-filter.test.ts` (append word-scan cases)

**Interfaces:**
- Consumes: `COUNTRY_ALIASES`, `US_STATES`, `US_STATE_NAMES`, `CA_PROVINCES`, `CA_PROVINCE_NAMES` from Task 1.
- Produces: `parseCountry` recognizes signals embedded as a whole word inside a multi-word token.

- [ ] **Step 1: Write failing tests for word-embedded signals and semicolon split**

Append to the `cases` array in `src/matching/location-filter.test.ts`:

```typescript
    // Signal embedded as a whole word in a multi-word token
    ["Remote US", "US"],
    ["Remote U.S.", "US"],
    ["US West", "US"],
    ["Remote - US East", "US"],
    ["Remote - US Central", "US"],
    ["Remote Canada", "Canada"],
    // Semicolon splits multi-location; last country wins (end-first)
    ["APAC - Australia; Singapore", "Singapore"],
    // Whole-word only: a token containing "business" must NOT match "us"
    ["Business Development, Remote", undefined],
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/matching/location-filter.test.ts`
Expected: FAIL — `"Remote US" -> "US"` fails (token "Remote US" isn't split on whitespace, so it never equals "us"); `"APAC - Australia; Singapore" -> "Singapore"` fails (the `;` isn't a delimiter). The `"Business Development, Remote" -> undefined` case currently PASSES (nothing matches) and must stay passing after the change.

- [ ] **Step 3: Add `;` to the split delimiter set**

In `src/matching/location-filter.ts`, change the split (currently `location.split(/[,()\-–—/]/)` around line 46) to include `;`:

```typescript
  // Split on commas / parens / dashes / slashes / semicolons so "Remote - US" and
  // "Berlin, Germany" and "Australia; Singapore" all surface their parts.
  const tokens = location
    .split(/[,()\-–—/;]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
```

- [ ] **Step 4: Add a whole-word scan within each token**

Add a helper above `parseCountry` that resolves a single normalized string against all sets, and a word-level fallback in the loop. Replace the loop body (from Task 1 Step 4) with:

```typescript
  // Resolve a single normalized token/word against the alias + state/province sets. Returns the
  // canonical country or undefined. Whole-string match only (callers pass already-split words), so
  // "business" can never resolve via a substring of "us".
  const resolveKey = (key: string): string | undefined => {
    const alias = COUNTRY_ALIASES[key];
    if (alias !== undefined) return alias;
    if (US_STATES.has(key) || US_STATE_NAMES.has(key)) return "US";
    if (CA_PROVINCES.has(key) || CA_PROVINCE_NAMES.has(key)) return "Canada";
    return undefined;
  };

  // Check tokens from the end first — the country/region usually trails the city.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    if (token === undefined) continue;
    // 1) Whole-token match first, so multi-word aliases ("united arab emirates", "british columbia")
    //    and multi-word state names ("new york") resolve before word-splitting can break them apart.
    const wholeToken = resolveKey(normalizeToken(token));
    if (wholeToken !== undefined) return wholeToken;
    // 2) Otherwise scan each whitespace-separated word (still whole-word exact).
    const words = token.split(/\s+/).filter((w) => w.length > 0);
    for (const word of words) {
      const byWord = resolveKey(normalizeToken(word));
      if (byWord !== undefined) return byWord;
    }
  }
```

Move `resolveKey` to module scope if biome flags it as recreated per call; keeping it inside is fine for correctness. (Note: `normalizeToken` already exists at line 38.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/matching/location-filter.test.ts`
Expected: PASS for all cases including `"Remote US" -> "US"`, `"US West" -> "US"`, `"APAC - Australia; Singapore" -> "Singapore"`, and `"Business Development, Remote" -> undefined` (because "business" and "development" and "remote" are none of the keys — "us" is not a substring match).

- [ ] **Step 6: Run the full matching suite and lint**

Run: `npx vitest run src/matching/ && ./node_modules/.bin/biome check src/matching/location-filter.ts`
Expected: all pass, no lint errors.

- [ ] **Step 7: Commit**

```bash
git add src/matching/location-filter.ts src/matching/location-filter.test.ts
git commit -m "feat(location): word-level country scan and semicolon split"
```

---

### Task 3: Backfill existing postings in `migrate()`

**Files:**
- Modify: `src/storage/repository.ts` `migrate()` (add after the existing `company_id` backfill, after line ~161)
- Test: `src/storage/repository.test.ts` (add a `describe` for the country backfill)

**Interfaces:**
- Consumes: `parseCountry` from `src/matching/location-filter.ts` (Tasks 1-2).
- Produces: after `migrate()`, postings with a now-parseable location and `country IS NULL` have `country` set; genuinely-unknown ones stay NULL; running `migrate()` again changes nothing.

- [ ] **Step 1: Confirm the import path and existing backfill pattern**

Read `src/storage/repository.ts` around lines 140-161 (the `companiesNeedingId` backfill) — the new backfill mirrors it (SELECT rows needing work → prepared UPDATE → `this.db.transaction`). Confirm `parseCountry` is importable; if `src/matching/location-filter` isn't already imported in repository.ts, add `import { parseCountry } from "@app/matching/location-filter";` at the top.

- [ ] **Step 2: Write the failing backfill test**

Follow the file's existing migrate-test idiom (see `repository.test.ts:577-613`): create a raw `Database` at a temp file path, insert legacy rows with `country` NULL, then open it through `new Repository(dbPath)` which runs `migrate()`. `migrate()` triggering a second time is achieved by opening `new Repository(dbPath)` again on the same file. `Database` is imported from `better-sqlite3`; `mkdtempSync`/`rmSync`/`tmpdir`/`join` are already imported at the top of the file. Add:

```typescript
describe("country backfill on migrate", () => {
  it("fills country for now-parseable locations, leaves bare cities NULL, and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobhunter-country-backfill-"));
    const dbPath = join(dir, "legacy.db");
    try {
      // A minimal legacy postings table WITH a country column but NULL values, mimicking rows the
      // old parser couldn't resolve. (The country column already exists on any DB that ran a prior
      // migrate; we set it NULL here to represent unresolved rows.)
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE postings (
          id TEXT PRIMARY KEY, company TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
          source TEXT NOT NULL, description TEXT NOT NULL, location TEXT, posted_at TEXT,
          fetched_at TEXT NOT NULL, last_seen_scan INTEGER, expired_at TEXT, country TEXT
        );
      `);
      const insert = raw.prepare(
        "INSERT INTO postings (id, company, title, url, source, description, location, fetched_at, country) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      );
      const t = "2026-01-01T00:00:00.000Z";
      insert.run("p-tx", "acme", "Eng", "https://a/1", "greenhouse", "", "Austin, Texas", t);
      insert.run("p-sf", "acme", "Eng", "https://a/2", "greenhouse", "", "San Francisco", t);
      insert.run("p-empty", "acme", "Eng", "https://a/3", "greenhouse", "", "", t);
      raw.close();

      // Reopen through Repository — migrate() runs and backfills country.
      new Repository(dbPath);

      const check = new Database(dbPath);
      const country = (id: string) =>
        (check.prepare("SELECT country FROM postings WHERE id = ?").get(id) as {
          country: string | null;
        }).country;
      expect(country("p-tx")).toBe("US");
      expect(country("p-sf")).toBeNull();
      expect(country("p-empty")).toBeNull();
      check.close();

      // Idempotent: a second migrate() (via re-open) leaves the same values.
      new Repository(dbPath);
      const check2 = new Database(dbPath);
      expect(
        (check2.prepare("SELECT country FROM postings WHERE id = ?").get("p-tx") as {
          country: string | null;
        }).country,
      ).toBe("US");
      check2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

Confirm `Database` is imported at the top of `repository.test.ts` (it is, for the existing migrate tests). If not, add `import Database from "better-sqlite3";`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/storage/repository.test.ts -t "country backfill"`
Expected: FAIL — `country("p-tx").country` is `null` (no backfill exists yet), so `expect(...).toBe("US")` fails.

- [ ] **Step 4: Implement the backfill in `migrate()`**

In `src/storage/repository.ts`, after the `failed_leads` company_id backfill (around line 161, after `backfillLeads(...)`), add:

```typescript
    // Re-derive country for legacy postings the improved parser can now resolve. Only rows with a
    // NULL country and a non-empty location are considered; genuinely-unknown locations stay NULL.
    // Idempotent: once a row's country is set it no longer matches `country IS NULL`.
    const postingsNeedingCountry = this.db
      .prepare(
        "SELECT id, location FROM postings WHERE country IS NULL AND location IS NOT NULL AND location != ''",
      )
      .all() as { id: string; location: string }[];
    const setPostingCountry = this.db.prepare("UPDATE postings SET country = ? WHERE id = ?");
    const backfillCountries = this.db.transaction((rows: { id: string; location: string }[]) => {
      for (const row of rows) {
        const country = parseCountry(row.location);
        if (country !== undefined) setPostingCountry.run(country, row.id);
      }
    });
    backfillCountries(postingsNeedingCountry);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/storage/repository.test.ts -t "country backfill"`
Expected: PASS — `p-tx` → "US", `p-sf` → null, `p-empty` → null, and idempotent on second migrate.

- [ ] **Step 6: Run the full storage + matching suites and lint**

Run: `npx vitest run src/storage/ src/matching/ && ./node_modules/.bin/biome check src/storage/repository.ts`
Expected: all pass, no lint errors.

- [ ] **Step 7: Commit**

```bash
git add src/storage/repository.ts src/storage/repository.test.ts
git commit -m "feat(storage): backfill posting country on migrate via parseCountry"
```

---

### Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck, lint, full suite with coverage**

Run: `npm run typecheck && ./node_modules/.bin/biome check . && npm run test:coverage`
Expected: typecheck clean, no lint errors, all tests pass, coverage ≥ 93/85/90/93.

- [ ] **Step 2: Sanity-check against real data (optional, manual)**

Run the dev CLI against a throwaway copy of the DB or inspect `parseCountry` outputs for the samples in the spec ("Austin, Texas"→US, "Dublin, Ireland"→Ireland, "San Francisco"→undefined). This is a confidence check, not a gate.

- [ ] **Step 3: Confirm no regression in existing parseCountry cases**

Run: `npx vitest run src/matching/location-filter.test.ts`
Expected: every original case (Berlin/Germany, London/UK, San Francisco CA/US, Toronto/Canada, "Anywhere"/undefined) still passes alongside the new ones.

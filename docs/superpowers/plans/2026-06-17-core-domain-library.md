# Core Domain Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure-TypeScript, fully unit-tested core of Job Hunter — shared domain types, skill extraction, resume reading, profile building, the heuristic match scorer, the freshness detector, and local SQLite storage — with no Electron, no live network, and no UI.

**Architecture:** A framework-free TypeScript library under `src/`. Every unit is a pure function or a thin class with one responsibility and an explicit interface, tested in isolation with Vitest against in-line inputs and small fixtures. Network I/O (scraping, liveness fetching) and the LLM scorer are deliberately excluded — this plan defines the *pure* detectors and contracts those later plans will feed. Storage is a synchronous `better-sqlite3` repository accepting an arbitrary DB path so tests can use an in-memory database.

**Tech Stack:** TypeScript (strict, ESM), Vitest (esbuild-powered test transform), better-sqlite3. **Biome** as the single linter + formatter (replaces ESLint + Prettier). Type-checking is `tsc --noEmit` only — **Plan 1 emits no JS**: the core library has no consumer yet and Vitest runs the TypeScript directly, so no transpile/build step is introduced here. When the Electron app lands (Plan 4), **electron-vite** (Vite/esbuild) handles all transpiling + bundling — one transpiler, no redundancy — and the renderer↔main boundary uses **tRPC over IPC** (`electron-trpc`) for typed procedures and streaming progress. The Biome config carries forward unchanged into the Electron + React plans. Package manager: npm.

## Global Constraints

- **Language:** TypeScript, `strict: true`, ESM (`"type": "module"`). No `any`. No non-null `!` assertions. Avoid type assertions outside tests.
- **Node:** target Node 22 (global `fetch` available for later plans). Use `node:`-prefixed core imports.
- **Lint/format:** Biome is the single source of truth (`npm run lint` / `npm run format`). Code must pass `biome check` clean.
- **No live network in this plan.** All behavior here is pure or local-file/local-DB only.
- **Resume formats in this plan:** `.txt` and `.md` only. `.pdf`/`.docx` are added in Plan 2; until then `readResumeText` throws a typed `UnsupportedFormatError` for them.
- **Skill values are normalized** (lower-cased, trimmed, alias-mapped) everywhere they cross a boundary, via `normalizeSkill`.
- **Tests must not hard-code magic numbers in `expect`.** Derive expected values from inputs or assert relationships/membership (project preference).
- **Commits:** Conventional Commits. Never add a Claude co-author footer. Solo project — commit directly to `main`.

---

### Task 1: Project scaffold & test runner

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `biome.json`
- Create: `.gitignore`
- Test: `src/sanity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `npm test` (Vitest), `npm run typecheck` (`tsc --noEmit`), and `npm run lint` (`biome check`). All later tasks rely on these commands.

- [ ] **Step 1: Write the failing test**

`src/sanity.test.ts`:
```ts
import { describe, expect, it } from "vitest";

describe("scaffold", () => {
  it("runs the test runner", () => {
    const sum = 2 + 3;
    expect(sum).toBe(2 + 3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `npm` error "Missing script: test" (no `package.json` yet).

- [ ] **Step 3: Create the scaffold files**

`package.json`:
```json
{
  "name": "job-hunter",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "format": "biome format --write ."
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.4",
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0"
  }
}
```

`biome.json`:
```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "ignore": ["dist", "node_modules", "coverage"] },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "javascript": { "formatter": { "quoteStyle": "double" } }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

`.gitignore`:
```
node_modules/
dist/
*.log
.DS_Store
```

- [ ] **Step 4: Install and run tests to verify they pass**

Run: `npm install`, then `npm test`, then `npm run lint`
Expected: `npm install` completes; `npm test` PASSES (1 test); `npm run lint` reports no errors.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts biome.json .gitignore src/sanity.test.ts
git commit -m "chore: scaffold typescript library with vitest and biome"
```

---

### Task 2: Domain types & skill normalization

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/domain/normalize.ts`
- Test: `src/domain/normalize.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Types `SkillProfile`, `JobPosting`, `MatchResult`, `LiveStatus`, `Warning`, and interface `Scorer` (in `types.ts`).
  - `normalizeSkill(raw: string): string` (in `normalize.ts`).

- [ ] **Step 1: Write the failing test**

`src/domain/normalize.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { normalizeSkill } from "./normalize.js";

describe("normalizeSkill", () => {
  it("lower-cases, trims, and collapses whitespace", () => {
    const raw = "  Type   Script ";
    expect(normalizeSkill(raw)).toBe("type script");
  });

  it("maps known aliases to a canonical form", () => {
    expect(normalizeSkill("Node.js")).toBe(normalizeSkill("nodejs"));
    expect(normalizeSkill("React.js")).toBe("react");
    expect(normalizeSkill("TS")).toBe("typescript");
  });

  it("leaves unknown skills unchanged except for casing/spacing", () => {
    expect(normalizeSkill("Kubernetes")).toBe("kubernetes");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- normalize`
Expected: FAIL — cannot find module `./normalize.js`.

- [ ] **Step 3: Write the implementation**

`src/domain/types.ts`:
```ts
export type SkillProfile = {
  skills: string[];
  roleKeywords: string[];
  categories: string[];
  yearsExperience?: number;
};

export type JobPosting = {
  id: string;
  company: string;
  title: string;
  url: string;
  source: string;
  description: string;
  location?: string;
  postedAt?: Date;
  fetchedAt: Date;
};

export type MatchResult = {
  score: number;
  matchedSkills: string[];
  missingSkills: string[];
  rationale?: string;
};

export type LiveStatus = "live" | "expired" | "unknown";

export type Warning = {
  source: string;
  message: string;
};

export interface Scorer {
  score(profile: SkillProfile, posting: JobPosting): MatchResult | Promise<MatchResult>;
}
```

`src/domain/normalize.ts`:
```ts
const SKILL_ALIASES: Record<string, string> = {
  "node.js": "node",
  "nodejs": "node",
  "react.js": "react",
  "reactjs": "react",
  "postgres": "postgresql",
  "ts": "typescript",
  "js": "javascript",
};

export function normalizeSkill(raw: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return SKILL_ALIASES[cleaned] ?? cleaned;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- normalize`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/types.ts src/domain/normalize.ts src/domain/normalize.test.ts
git commit -m "feat: add domain types and skill normalization"
```

---

### Task 3: Skill dictionary & extraction

**Files:**
- Create: `src/domain/skill-dictionary.ts`
- Create: `src/domain/extract-skills.ts`
- Test: `src/domain/extract-skills.test.ts`

**Interfaces:**
- Consumes: `normalizeSkill` (Task 2).
- Produces:
  - `DEFAULT_SKILL_DICTIONARY: string[]` (in `skill-dictionary.ts`).
  - `extractSkills(text: string, dictionary?: string[]): string[]` — returns a deduplicated, normalized list of dictionary skills found in `text` (in `extract-skills.ts`).

- [ ] **Step 1: Write the failing test**

`src/domain/extract-skills.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { extractSkills } from "./extract-skills.js";
import { normalizeSkill } from "./normalize.js";

const DICT = ["TypeScript", "React", "Node.js", "AWS", "Go"];

describe("extractSkills", () => {
  it("finds dictionary skills present in the text, normalized", () => {
    const text = "Senior engineer with TypeScript and React experience.";
    const result = extractSkills(text, DICT);
    expect(result).toContain(normalizeSkill("TypeScript"));
    expect(result).toContain(normalizeSkill("React"));
    expect(result).not.toContain(normalizeSkill("Go"));
  });

  it("matches on token boundaries, not substrings", () => {
    const text = "We use Goland the IDE, not the language.";
    const result = extractSkills(text, DICT);
    expect(result).not.toContain(normalizeSkill("Go"));
  });

  it("matches skills containing punctuation", () => {
    const text = "Backend on Node.js services.";
    const result = extractSkills(text, DICT);
    expect(result).toContain(normalizeSkill("Node.js"));
  });

  it("deduplicates repeated mentions", () => {
    const text = "react React REACT";
    const result = extractSkills(text, DICT);
    const reactCount = result.filter((s) => s === normalizeSkill("React")).length;
    expect(reactCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- extract-skills`
Expected: FAIL — cannot find module `./extract-skills.js`.

- [ ] **Step 3: Write the implementation**

`src/domain/skill-dictionary.ts`:
```ts
export const DEFAULT_SKILL_DICTIONARY: string[] = [
  "TypeScript",
  "JavaScript",
  "Node.js",
  "React",
  "Angular",
  "NestJS",
  "Python",
  "Go",
  "Java",
  "SQL",
  "PostgreSQL",
  "MySQL",
  "AWS",
  "Terraform",
  "Docker",
  "Kubernetes",
  "GraphQL",
  "REST",
  "Temporal",
  "Bash",
];
```

`src/domain/extract-skills.ts`:
```ts
import { DEFAULT_SKILL_DICTIONARY } from "./skill-dictionary.js";
import { normalizeSkill } from "./normalize.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function skillPattern(skill: string): RegExp {
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(skill.toLowerCase())}(?![a-z0-9])`, "i");
}

export function extractSkills(
  text: string,
  dictionary: string[] = DEFAULT_SKILL_DICTIONARY,
): string[] {
  const found = new Set<string>();
  for (const skill of dictionary) {
    if (skillPattern(skill).test(text)) {
      found.add(normalizeSkill(skill));
    }
  }
  return [...found];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- extract-skills`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/skill-dictionary.ts src/domain/extract-skills.ts src/domain/extract-skills.test.ts
git commit -m "feat: add skill dictionary and text extraction"
```

---

### Task 4: Resume reading (txt/md)

**Files:**
- Create: `src/profile/read-resume.ts`
- Test: `src/profile/read-resume.test.ts`
- Test fixtures: `src/profile/__fixtures__/resume.md`, `src/profile/__fixtures__/resume.txt`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `readResumeText(filePath: string): Promise<string>` — reads `.txt`/`.md` as UTF-8.
  - `class UnsupportedFormatError extends Error` with a readonly `ext: string`.

- [ ] **Step 1: Write the failing test**

Create fixture `src/profile/__fixtures__/resume.md`:
```markdown
# Jane Doe
Senior Engineer skilled in TypeScript, React, and AWS.
```

Create fixture `src/profile/__fixtures__/resume.txt`:
```
Jane Doe
Senior Engineer skilled in TypeScript, React, and AWS.
```

`src/profile/read-resume.test.ts`:
```ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readResumeText, UnsupportedFormatError } from "./read-resume.js";

function fixture(name: string): string {
  return fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
}

describe("readResumeText", () => {
  it("reads a markdown resume as text", async () => {
    const path = fixture("resume.md");
    const expected = await readFile(path, "utf8");
    expect(await readResumeText(path)).toBe(expected);
  });

  it("reads a plain-text resume as text", async () => {
    const path = fixture("resume.txt");
    const expected = await readFile(path, "utf8");
    expect(await readResumeText(path)).toBe(expected);
  });

  it("throws a typed error for unsupported formats", async () => {
    await expect(readResumeText("/tmp/resume.pdf")).rejects.toBeInstanceOf(
      UnsupportedFormatError,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- read-resume`
Expected: FAIL — cannot find module `./read-resume.js`.

- [ ] **Step 3: Write the implementation**

`src/profile/read-resume.ts`:
```ts
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export class UnsupportedFormatError extends Error {
  constructor(public readonly ext: string) {
    super(`Unsupported resume format "${ext}". Paste your resume text manually instead.`);
    this.name = "UnsupportedFormatError";
  }
}

const TEXT_EXTENSIONS = new Set([".txt", ".md"]);

export async function readResumeText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) {
    return readFile(filePath, "utf8");
  }
  throw new UnsupportedFormatError(ext);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- read-resume`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/profile/read-resume.ts src/profile/read-resume.test.ts src/profile/__fixtures__/resume.md src/profile/__fixtures__/resume.txt
git commit -m "feat: read txt and md resumes into text"
```

---

### Task 5: Build skill profile

**Files:**
- Create: `src/profile/build-profile.ts`
- Test: `src/profile/build-profile.test.ts`

**Interfaces:**
- Consumes: `extractSkills` (Task 3), `normalizeSkill` (Task 2), `SkillProfile` (Task 2).
- Produces:
  - `type BuildProfileInput = { resumeText?: string; manualSkills?: string[]; roleKeywords?: string[]; categories?: string[]; yearsExperience?: number; dictionary?: string[] }`
  - `buildProfile(input: BuildProfileInput): SkillProfile` — merges resume-extracted skills with manual skills (normalized, deduped); passes through role keywords and categories.

- [ ] **Step 1: Write the failing test**

`src/profile/build-profile.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildProfile } from "./build-profile.js";
import { extractSkills } from "../domain/extract-skills.js";
import { normalizeSkill } from "../domain/normalize.js";

describe("buildProfile", () => {
  it("merges resume-extracted skills with manual skills, normalized and deduped", () => {
    const resumeText = "Engineer with TypeScript and React.";
    const profile = buildProfile({
      resumeText,
      manualSkills: ["AWS", "typescript"],
    });

    const fromResume = extractSkills(resumeText);
    for (const skill of fromResume) {
      expect(profile.skills).toContain(skill);
    }
    expect(profile.skills).toContain(normalizeSkill("AWS"));

    const tsCount = profile.skills.filter((s) => s === normalizeSkill("TypeScript")).length;
    expect(tsCount).toBe(1);
  });

  it("passes through role keywords and categories", () => {
    const profile = buildProfile({
      roleKeywords: ["Frontend Engineer"],
      categories: ["Engineering", "Remote"],
      yearsExperience: 15,
    });
    expect(profile.roleKeywords).toContain("frontend engineer");
    expect(profile.categories).toEqual(["Engineering", "Remote"]);
    expect(profile.yearsExperience).toBe(15);
  });

  it("produces an empty skill list when given no input", () => {
    const profile = buildProfile({});
    expect(profile.skills).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- build-profile`
Expected: FAIL — cannot find module `./build-profile.js`.

- [ ] **Step 3: Write the implementation**

`src/profile/build-profile.ts`:
```ts
import type { SkillProfile } from "../domain/types.js";
import { extractSkills } from "../domain/extract-skills.js";
import { normalizeSkill } from "../domain/normalize.js";

export type BuildProfileInput = {
  resumeText?: string;
  manualSkills?: string[];
  roleKeywords?: string[];
  categories?: string[];
  yearsExperience?: number;
  dictionary?: string[];
};

export function buildProfile(input: BuildProfileInput): SkillProfile {
  const fromResume = input.resumeText ? extractSkills(input.resumeText, input.dictionary) : [];
  const fromManual = (input.manualSkills ?? []).map(normalizeSkill);
  const skills = [...new Set([...fromResume, ...fromManual])];
  const roleKeywords = [...new Set((input.roleKeywords ?? []).map(normalizeSkill))];

  return {
    skills,
    roleKeywords,
    categories: input.categories ?? [],
    yearsExperience: input.yearsExperience,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- build-profile`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/profile/build-profile.ts src/profile/build-profile.test.ts
git commit -m "feat: build skill profile from resume and manual input"
```

---

### Task 6: Heuristic match scorer

**Files:**
- Create: `src/matching/heuristic-scorer.ts`
- Test: `src/matching/heuristic-scorer.test.ts`

**Interfaces:**
- Consumes: `Scorer`, `SkillProfile`, `JobPosting`, `MatchResult` (Task 2); `extractSkills` (Task 3).
- Produces:
  - `class HeuristicScorer implements Scorer` with `score(profile, posting): MatchResult`.
  - Scoring contract: `matchedSkills` = posting skills also in the profile; `missingSkills` = posting skills absent from the profile; `score` is an integer in `[0, 100]` that increases with the matched fraction and with role-keyword presence in the title.

- [ ] **Step 1: Write the failing test**

`src/matching/heuristic-scorer.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { HeuristicScorer } from "./heuristic-scorer.js";
import type { JobPosting, SkillProfile } from "../domain/types.js";

function posting(overrides: Partial<JobPosting>): JobPosting {
  return {
    id: "1",
    company: "Acme",
    title: "Engineer",
    url: "https://example.com/1",
    source: "test",
    description: "",
    fetchedAt: new Date(0),
    ...overrides,
  };
}

const profile: SkillProfile = {
  skills: ["typescript", "react"],
  roleKeywords: ["frontend engineer"],
  categories: [],
};

describe("HeuristicScorer", () => {
  const scorer = new HeuristicScorer();

  it("identifies matched and missing skills from the posting", () => {
    const result = scorer.score(
      profile,
      posting({ description: "We need TypeScript, React, and Go." }),
    );
    expect(result.matchedSkills.sort()).toEqual(["react", "typescript"]);
    expect(result.missingSkills).toContain("go");
  });

  it("keeps the score within 0..100", () => {
    const result = scorer.score(profile, posting({ description: "TypeScript React Go AWS" }));
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("scores a fully-matching posting higher than a partially-matching one", () => {
    const full = scorer.score(profile, posting({ description: "TypeScript and React." }));
    const partial = scorer.score(profile, posting({ description: "TypeScript, React, Go, AWS." }));
    expect(full.score).toBeGreaterThan(partial.score);
  });

  it("rewards a role-keyword match in the title", () => {
    const withTitle = scorer.score(
      profile,
      posting({ title: "Frontend Engineer", description: "TypeScript, Go." }),
    );
    const withoutTitle = scorer.score(
      profile,
      posting({ title: "Data Scientist", description: "TypeScript, Go." }),
    );
    expect(withTitle.score).toBeGreaterThan(withoutTitle.score);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- heuristic-scorer`
Expected: FAIL — cannot find module `./heuristic-scorer.js`.

- [ ] **Step 3: Write the implementation**

`src/matching/heuristic-scorer.ts`:
```ts
import type { JobPosting, MatchResult, Scorer, SkillProfile } from "../domain/types.js";
import { extractSkills } from "../domain/extract-skills.js";

const SKILL_WEIGHT = 0.8;
const TITLE_WEIGHT = 0.2;

export class HeuristicScorer implements Scorer {
  constructor(private readonly dictionary?: string[]) {}

  score(profile: SkillProfile, posting: JobPosting): MatchResult {
    const text = `${posting.title}\n${posting.description}`;
    const postingSkills = extractSkills(text, this.dictionary);
    const profileSkills = new Set(profile.skills);

    const matchedSkills = postingSkills.filter((skill) => profileSkills.has(skill));
    const missingSkills = postingSkills.filter((skill) => !profileSkills.has(skill));

    const skillFraction =
      postingSkills.length === 0 ? 0 : matchedSkills.length / postingSkills.length;
    const titleFraction = this.titleKeywordFraction(profile.roleKeywords, posting.title);

    const score = Math.round((skillFraction * SKILL_WEIGHT + titleFraction * TITLE_WEIGHT) * 100);

    return { score, matchedSkills, missingSkills };
  }

  private titleKeywordFraction(roleKeywords: string[], title: string): number {
    if (roleKeywords.length === 0) return 0;
    const haystack = title.toLowerCase();
    const hits = roleKeywords.filter((keyword) => haystack.includes(keyword)).length;
    return hits / roleKeywords.length;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- heuristic-scorer`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/matching/heuristic-scorer.ts src/matching/heuristic-scorer.test.ts
git commit -m "feat: add heuristic match scorer"
```

---

### Task 7: Freshness detector (pure)

**Files:**
- Create: `src/freshness/detect-liveness.ts`
- Test: `src/freshness/detect-liveness.test.ts`

**Interfaces:**
- Consumes: `LiveStatus` (Task 2).
- Produces:
  - `type LivenessSignal` — a discriminated union: `{ kind: "ats-feed"; postingPresent: boolean }` or `{ kind: "http"; statusCode: number; finalUrl: string; originalUrl: string; bodyText: string }`.
  - `detectLiveness(signal: LivenessSignal): LiveStatus` — pure classifier. (Plan 2 supplies the network fetch that produces a `LivenessSignal`.)

- [ ] **Step 1: Write the failing test**

`src/freshness/detect-liveness.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { detectLiveness, type LivenessSignal } from "./detect-liveness.js";

function http(overrides: Partial<Extract<LivenessSignal, { kind: "http" }>>): LivenessSignal {
  return {
    kind: "http",
    statusCode: 200,
    originalUrl: "https://example.com/job/1",
    finalUrl: "https://example.com/job/1",
    bodyText: "Apply now for this great role.",
    ...overrides,
  };
}

describe("detectLiveness", () => {
  it("treats an ATS feed containing the posting as live", () => {
    expect(detectLiveness({ kind: "ats-feed", postingPresent: true })).toBe("live");
  });

  it("treats an ATS feed missing the posting as expired", () => {
    expect(detectLiveness({ kind: "ats-feed", postingPresent: false })).toBe("expired");
  });

  it("treats 404/410 as expired", () => {
    expect(detectLiveness(http({ statusCode: 404 }))).toBe("expired");
    expect(detectLiveness(http({ statusCode: 410 }))).toBe("expired");
  });

  it("treats expired-marker copy as expired", () => {
    expect(
      detectLiveness(http({ bodyText: "This position has been filled. Thank you." })),
    ).toBe("expired");
  });

  it("treats a healthy 2xx page as live", () => {
    expect(detectLiveness(http({ statusCode: 200 }))).toBe("live");
  });

  it("treats other status codes as unknown", () => {
    expect(detectLiveness(http({ statusCode: 503 }))).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- detect-liveness`
Expected: FAIL — cannot find module `./detect-liveness.js`.

- [ ] **Step 3: Write the implementation**

`src/freshness/detect-liveness.ts`:
```ts
import type { LiveStatus } from "../domain/types.js";

export type LivenessSignal =
  | { kind: "ats-feed"; postingPresent: boolean }
  | { kind: "http"; statusCode: number; finalUrl: string; originalUrl: string; bodyText: string };

const EXPIRED_MARKERS = [
  "no longer accepting applications",
  "this position has been filled",
  "position is no longer available",
  "job posting not found",
  "this job is no longer available",
];

export function detectLiveness(signal: LivenessSignal): LiveStatus {
  if (signal.kind === "ats-feed") {
    return signal.postingPresent ? "live" : "expired";
  }

  if (signal.statusCode === 404 || signal.statusCode === 410) {
    return "expired";
  }

  const body = signal.bodyText.toLowerCase();
  if (EXPIRED_MARKERS.some((marker) => body.includes(marker))) {
    return "expired";
  }

  if (signal.statusCode >= 200 && signal.statusCode < 300) {
    return "live";
  }

  return "unknown";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- detect-liveness`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/freshness/detect-liveness.ts src/freshness/detect-liveness.test.ts
git commit -m "feat: add pure liveness detector"
```

---

### Task 8: SQLite repository

**Files:**
- Create: `src/storage/schema.ts`
- Create: `src/storage/repository.ts`
- Test: `src/storage/repository.test.ts`

**Interfaces:**
- Consumes: `SkillProfile`, `JobPosting`, `MatchResult` (Task 2).
- Produces:
  - `class Repository` constructed from a DB path (`":memory:"` allowed for tests), exposing:
    - `saveProfile(profile: SkillProfile): number` → row id
    - `savePosting(posting: JobPosting): void`
    - `saveMatchResult(postingId: string, result: MatchResult): void`
    - `setUserAction(postingId: string, action: "saved" | "dismissed"): void`
    - `getSetting(key: string): string | undefined`
    - `setSetting(key: string, value: string): void`
    - `close(): void`

- [ ] **Step 1: Write the failing test**

`src/storage/repository.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { Repository } from "./repository.js";
import type { JobPosting, MatchResult, SkillProfile } from "../domain/types.js";

function newRepo(): Repository {
  return new Repository(":memory:");
}

const profile: SkillProfile = {
  skills: ["typescript"],
  roleKeywords: ["frontend engineer"],
  categories: ["Engineering"],
  yearsExperience: 15,
};

const posting: JobPosting = {
  id: "abc",
  company: "Acme",
  title: "Engineer",
  url: "https://example.com/abc",
  source: "greenhouse",
  description: "TypeScript role",
  fetchedAt: new Date("2026-06-17T00:00:00Z"),
};

describe("Repository", () => {
  it("round-trips a setting", () => {
    const repo = newRepo();
    repo.setSetting("apiKey", "secret-value");
    expect(repo.getSetting("apiKey")).toBe("secret-value");
    repo.close();
  });

  it("returns undefined for a missing setting", () => {
    const repo = newRepo();
    expect(repo.getSetting("missing")).toBeUndefined();
    repo.close();
  });

  it("overwrites a setting on repeated set", () => {
    const repo = newRepo();
    repo.setSetting("apiKey", "first");
    repo.setSetting("apiKey", "second");
    expect(repo.getSetting("apiKey")).toBe("second");
    repo.close();
  });

  it("saves a profile and returns a positive row id", () => {
    const repo = newRepo();
    const id = repo.saveProfile(profile);
    expect(id).toBeGreaterThan(0);
    repo.close();
  });

  it("saves a posting and an idempotent user action without throwing", () => {
    const repo = newRepo();
    repo.savePosting(posting);
    repo.setUserAction(posting.id, "saved");
    repo.setUserAction(posting.id, "dismissed");
    repo.close();
  });

  it("saves a match result for a stored posting", () => {
    const repo = newRepo();
    repo.savePosting(posting);
    const result: MatchResult = { score: 50, matchedSkills: ["typescript"], missingSkills: ["go"] };
    expect(() => repo.saveMatchResult(posting.id, result)).not.toThrow();
    repo.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- repository`
Expected: FAIL — cannot find module `./repository.js`.

- [ ] **Step 3: Write the schema**

`src/storage/schema.ts`:
```ts
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS postings (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  source TEXT NOT NULL,
  description TEXT NOT NULL,
  location TEXT,
  posted_at TEXT,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS match_results (
  posting_id TEXT PRIMARY KEY REFERENCES postings(id),
  score INTEGER NOT NULL,
  matched_skills TEXT NOT NULL,
  missing_skills TEXT NOT NULL,
  rationale TEXT
);

CREATE TABLE IF NOT EXISTS user_actions (
  posting_id TEXT PRIMARY KEY REFERENCES postings(id),
  action TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
```

- [ ] **Step 4: Write the repository**

`src/storage/repository.ts`:
```ts
import Database from "better-sqlite3";
import type { JobPosting, MatchResult, SkillProfile } from "../domain/types.js";
import { SCHEMA } from "./schema.js";

export class Repository {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  saveProfile(profile: SkillProfile): number {
    const statement = this.db.prepare("INSERT INTO profiles (data) VALUES (?)");
    const info = statement.run(JSON.stringify(profile));
    return Number(info.lastInsertRowid);
  }

  savePosting(posting: JobPosting): void {
    this.db
      .prepare(
        `INSERT INTO postings (id, company, title, url, source, description, location, posted_at, fetched_at)
         VALUES (@id, @company, @title, @url, @source, @description, @location, @postedAt, @fetchedAt)
         ON CONFLICT(id) DO UPDATE SET
           company = excluded.company,
           title = excluded.title,
           url = excluded.url,
           source = excluded.source,
           description = excluded.description,
           location = excluded.location,
           posted_at = excluded.posted_at,
           fetched_at = excluded.fetched_at`,
      )
      .run({
        id: posting.id,
        company: posting.company,
        title: posting.title,
        url: posting.url,
        source: posting.source,
        description: posting.description,
        location: posting.location ?? null,
        postedAt: posting.postedAt?.toISOString() ?? null,
        fetchedAt: posting.fetchedAt.toISOString(),
      });
  }

  saveMatchResult(postingId: string, result: MatchResult): void {
    this.db
      .prepare(
        `INSERT INTO match_results (posting_id, score, matched_skills, missing_skills, rationale)
         VALUES (@postingId, @score, @matched, @missing, @rationale)
         ON CONFLICT(posting_id) DO UPDATE SET
           score = excluded.score,
           matched_skills = excluded.matched_skills,
           missing_skills = excluded.missing_skills,
           rationale = excluded.rationale`,
      )
      .run({
        postingId,
        score: result.score,
        matched: JSON.stringify(result.matchedSkills),
        missing: JSON.stringify(result.missingSkills),
        rationale: result.rationale ?? null,
      });
  }

  setUserAction(postingId: string, action: "saved" | "dismissed"): void {
    this.db
      .prepare(
        `INSERT INTO user_actions (posting_id, action)
         VALUES (?, ?)
         ON CONFLICT(posting_id) DO UPDATE SET action = excluded.action, updated_at = datetime('now')`,
      )
      .run(postingId, action);
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 5: Run tests and typecheck to verify they pass**

Run: `npm test -- repository` then `npm run typecheck`
Expected: tests PASS (6 tests); typecheck reports no errors.

- [ ] **Step 6: Commit**

```bash
git add src/storage/schema.ts src/storage/repository.ts src/storage/repository.test.ts
git commit -m "feat: add sqlite repository for profiles, postings, and settings"
```

---

## Self-Review

**Spec coverage (against the design doc):**
- Shared domain types (`SkillProfile`, `JobPosting`, `MatchResult`, `LiveStatus`) → Task 2. ✅
- Profile module — resume parse (txt/md) + skill extraction + editable profile → Tasks 3–5 (PDF/docx explicitly deferred to Plan 2 per Global Constraints). ✅
- Matching module — `HeuristicScorer` (the "always the fallback" tier) + match %/matched/missing → Task 6. The `Scorer` interface (Task 2) is the seam the `LlmScorer` plugs into in Plan 3. ✅
- Freshness module — pure `detectLiveness` classifier covering ATS-feed and HTTP signals → Task 7. Network fetch deferred to Plan 2. ✅
- Storage — SQLite via a thin `Repository`, settings table for the (keychain-backed) API key reference → Task 8. ✅
- Out of scope for this plan (by design): Discovery/connectors (Plan 2), LLM scorer + key resolution (Plan 3), Electron shell + IPC (Plan 4), React UI + packaging (Plan 5).

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N" present. Every code step shows complete code. ✅

**Type consistency:** `Scorer.score` signature in Task 2 matches `HeuristicScorer.score` in Task 6. `LivenessSignal`/`LiveStatus` consistent between Tasks 2 and 7. `Repository` method names in the Task 8 interface block match the implementation. `BuildProfileInput` fields used in Task 5 tests match the type. ✅

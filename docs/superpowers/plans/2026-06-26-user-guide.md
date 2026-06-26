# User-facing Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a friendly, task-oriented user guide under `docs/guide/` for non-technical users, folding `docs/usage.md` into it.

**Architecture:** Flat markdown pages — an `index.md` router plus four content pages (getting-started, understanding-matches, using-the-dashboard, faq). `docs/usage.md` is removed and its content absorbed; its two inbound links are repointed. No build step, no new tooling. `docs/re-scan-behavior.md` stays as the reference companion.

**Tech Stack:** Markdown only (GitHub-rendered).

## Global Constraints

- **Voice:** non-technical end user. Plain language, no assumed knowledge of Node / CLI / SQLite.
- **Location:** all new pages under `docs/guide/`.
- **Screenshot placeholders:** every image placeholder uses the exact marker `<!-- SCREENSHOT: <description> -->` (greppable).
- **Commands:** the tool is invoked as `npm run cli -- <command>` (the `--` forwards flags). Match `docs/usage.md`'s phrasing.
- **No dangling links:** after removing `usage.md`, zero references to it may remain in the repo.
- **Source of truth for absorbed content:** `docs/usage.md` (read it before writing; do not invent commands, settings, or paths).

---

### Task 1: Scaffold `docs/guide/index.md` (the router)

**Files:**
- Create: `docs/guide/index.md`

**Interfaces:**
- Produces: the four page filenames the other tasks create — `getting-started.md`, `understanding-matches.md`, `using-the-dashboard.md`, `faq.md` — linked relatively from this index. Later tasks must use these exact names.

- [ ] **Step 1: Write `docs/guide/index.md`**

```markdown
# job-hunter — User Guide

job-hunter finds open roles for you. It reads a public directory of hiring companies (plus any you
add yourself), compares each open role to your resume, and gives you a ranked list of the best
matches — all on your own computer. Nothing about you is uploaded anywhere (see [privacy](./faq.md#privacy)).

## Where do I start?

- **New here?** → [Getting started](./getting-started.md) — install it, add your resume, run your first search.
- **Confused by your results?** → [Understanding your matches](./understanding-matches.md) — what the scores mean, and why your list might be empty or short.
- **Using the dashboard?** → [Using the dashboard](./using-the-dashboard.md) — a tour of each screen.
- **Quick question?** → [FAQ](./faq.md) — costs, privacy, where your data lives, and fixes for common problems.

---

*Looking for technical detail? See the [re-scan behavior reference](../re-scan-behavior.md) and the
[project README](../../README.md).*
```

- [ ] **Step 2: Verify the index links resolve**

Run: `cd docs/guide && for f in getting-started understanding-matches using-the-dashboard faq; do test -f $f.md && echo "ok $f" || echo "MISSING $f (expected — created in later tasks)"; done; cd ../..`
Expected: all four print `MISSING` for now (they're created in Tasks 2–5). This confirms the index references the right names; the files arrive in later tasks.

- [ ] **Step 3: Commit**

```bash
git add docs/guide/index.md
git commit -m "docs(guide): add user-guide index/router (#41)"
```

---

### Task 2: Write `docs/guide/getting-started.md`

**Files:**
- Create: `docs/guide/getting-started.md`
- Read first: `docs/usage.md` (commands), `README.md` (install prerequisites)

**Interfaces:**
- Consumes: page names from Task 1's index.
- Produces: anchor `#your-first-scan` is not required by other pages; no outbound contract beyond linking to `understanding-matches.md`, `using-the-dashboard.md`, and `faq.md`.

- [ ] **Step 1: Read the source material**

Run: `sed -n '1,80p' docs/usage.md` and skim `README.md` for the install/prereq steps (Node version, `npx playwright install chromium`). Use these verbatim — do not invent commands.

- [ ] **Step 2: Write `docs/guide/getting-started.md`**

Write the page with this structure and voice (numbered happy path). Fill the command blocks from `docs/usage.md`:

```markdown
# Getting started

This walks you from a fresh install to your first ranked list of jobs. It takes about ten minutes,
most of which is the first search running.

## 1. Install the prerequisites

<!-- SCREENSHOT: terminal after a successful install -->

You need [Node.js](https://nodejs.org) (version 22 or newer) and a one-time browser download the
tool uses to read company career pages:

\`\`\`bash
npm install
npx playwright install chromium chromium-headless-shell
\`\`\`

## 2. Add your resume

The tool needs your resume to know what to match against. Run setup and point it at your file
(`.pdf`, `.docx`, `.md`, or `.txt`):

\`\`\`bash
npm run setup
\`\`\`

Setup also asks whether to add an Anthropic API key. With a key, your matches are scored by Claude
for a much better fit; without one, a free offline scorer is used. You can add a key later — see the
[FAQ](./faq.md#scoring).

## 3. Run your first search

\`\`\`bash
npm run cli -- scan
\`\`\`

<!-- SCREENSHOT: a scan running in the terminal -->

This reads the company directory, fetches each company's open roles, and scores them against your
resume. A company that fails to load is skipped with a warning — the search still finishes.

## 4. See your matches

The quickest way is the dashboard:

\`\`\`bash
npm run cli -- serve
\`\`\`

<!-- SCREENSHOT: the dashboard Matches tab with results -->

Open the address it prints (usually <http://localhost:4317>). Or list them right in the terminal:

\`\`\`bash
npm run cli -- list
\`\`\`

## What's next

- Your list empty or shorter than expected? → [Understanding your matches](./understanding-matches.md)
- Want a tour of the dashboard? → [Using the dashboard](./using-the-dashboard.md)
```

- [ ] **Step 3: Verify placeholders use the marker**

Run: `grep -c "<!-- SCREENSHOT:" docs/guide/getting-started.md`
Expected: `3`

- [ ] **Step 4: Commit**

```bash
git add docs/guide/getting-started.md
git commit -m "docs(guide): add getting-started page (#41)"
```

---

### Task 3: Write `docs/guide/understanding-matches.md`

**Files:**
- Create: `docs/guide/understanding-matches.md`
- Read first: `docs/usage.md` ("How scoring works" section)

**Interfaces:**
- Consumes: links to `using-the-dashboard.md#skills` and `faq.md#scoring`.
- Produces: anchor `#why-is-my-list-empty-or-short` linked from the getting-started page's "What's next" and from the FAQ.

- [ ] **Step 1: Read the source**

Run: `sed -n '81,108p' docs/usage.md` (the "How scoring works" section). Use its facts (0–100 score, LLM vs. heuristic, default model) verbatim.

- [ ] **Step 2: Write `docs/guide/understanding-matches.md`**

```markdown
# Understanding your matches

## What a match is

Every open role you scan gets a **score from 0 to 100** — how well it fits your resume — along with:

- the **skills you share** with the role,
- the **skills the role wants that your resume doesn't show**, and
- (with Claude scoring) a **short rationale** explaining the fit.

The list is sorted best-first. By default, `list` shows roles scoring **50 or higher**.

## What the score means

A higher score means more of what the role asks for already appears in your resume. It is a
*ranking* aid, not a verdict — a 60 worth applying to beats a 90 you're not interested in. Treat it
as "look at these first," not "only these."

## Why is my list empty or short?

A few common reasons, and the fix for each:

- **The score cutoff is hiding them.** `list` defaults to 50+. See everything:
  \`\`\`bash
  npm run cli -- list --min-score 0
  \`\`\`
- **You're on the free offline scorer.** Without an Anthropic API key, scoring is keyword-based and
  tends to score lower and shallower. Add a key for semantic scoring — see the [FAQ](./faq.md#scoring).
- **Your skill profile is thin.** If the resume parser missed skills, fewer roles match. Add the
  missing ones in the dashboard's [Skills tab](./using-the-dashboard.md#skills).
- **It was a quiet scan.** Companies that failed to load are skipped (with warnings). Re-running the
  search later often picks them up.

## Skills come from your resume

Scoring compares each role to the **skills** extracted from your resume. If those are wrong or
incomplete, your matches will be too — so it's worth reviewing them in the
[Skills tab](./using-the-dashboard.md#skills) after your first search.
```

- [ ] **Step 3: Verify the page exists and links are present**

Run: `grep -c "faq.md#scoring\|using-the-dashboard.md#skills" docs/guide/understanding-matches.md`
Expected: `3` or more (multiple references).

- [ ] **Step 4: Commit**

```bash
git add docs/guide/understanding-matches.md
git commit -m "docs(guide): add understanding-matches page (#41)"
```

---

### Task 4: Write `docs/guide/using-the-dashboard.md`

**Files:**
- Create: `docs/guide/using-the-dashboard.md`
- Read first: `web/src/views/` (the five tab names: Overview, Matches, Companies, Skills, Settings)

**Interfaces:**
- Consumes: links to `../re-scan-behavior.md`.
- Produces: anchors `#skills` (linked from Task 3) and `#matches`. Heading text must yield those anchors — use `## Skills` and `## Matches`.

- [ ] **Step 1: Confirm the tab names**

Run: `ls web/src/views/`
Expected: `Companies.tsx  Matches.tsx  Overview.tsx  Settings.tsx  Skills.tsx`. Use exactly these five tab names.

- [ ] **Step 2: Write `docs/guide/using-the-dashboard.md`**

```markdown
# Using the dashboard

Start the dashboard with `npm run cli -- serve` and open the address it prints. It has five tabs.

## Overview

<!-- SCREENSHOT: the Overview tab -->

Your at-a-glance home: the latest search's results and what changed since last time — companies that
are **new** to the directory and ones that are **no longer listed**. Start a new search from here.

## Matches

<!-- SCREENSHOT: the Matches tab -->

Your ranked roles, best-first, each with its score, shared and missing skills, and rationale. Roles
that have since closed are hidden; flip **Show expired** to see them (dimmed, with an "expired"
badge) — handy for finding a role you already applied to. Why roles expire is explained in the
[re-scan reference](../re-scan-behavior.md).

## Companies

<!-- SCREENSHOT: the Companies tab -->

The companies you track yourself, on top of the public directory. Add one by its careers-page URL,
or remove one you're no longer interested in.

## Skills

<!-- SCREENSHOT: the Skills tab -->

The skills pulled from your resume — the basis for every score. Add ones the parser missed and
remove any that are wrong; better skills mean better matches. Worth a look after your first search.

## Settings

<!-- SCREENSHOT: the Settings tab -->

Your scoring setup — whether an Anthropic API key is configured and which model is used. See the
[FAQ](./faq.md#scoring) for what these change.
```

- [ ] **Step 3: Verify the marker count and anchors**

Run: `grep -c "<!-- SCREENSHOT:" docs/guide/using-the-dashboard.md` (expect `5`), then `grep -E "^## (Skills|Matches)$" docs/guide/using-the-dashboard.md` (expect both lines).

- [ ] **Step 4: Commit**

```bash
git add docs/guide/using-the-dashboard.md
git commit -m "docs(guide): add dashboard tour page (#41)"
```

---

### Task 5: Write `docs/guide/faq.md` (absorbs usage.md reference + troubleshooting)

**Files:**
- Create: `docs/guide/faq.md`
- Read first: `docs/usage.md` (Configuration, "Where your data lives", Troubleshooting, Privacy sections)

**Interfaces:**
- Consumes: links to `../re-scan-behavior.md`.
- Produces: anchors `#scoring` (linked from Tasks 2–4) and `#privacy` (linked from Task 1's index). Use headings `## Scoring` and `## Privacy` so those anchors exist.

- [ ] **Step 1: Read the source**

Run: `sed -n '93,146p' docs/usage.md` — the Configuration table, data-location paths, Troubleshooting, and Privacy. Copy settings names, env vars, and file paths **verbatim** (`anthropicApiKey`, `scorerModel`, `scorerProvider`, `JOB_HUNTER_HOME`, `AIRTABLE_SHARE_URL`, the DB paths).

- [ ] **Step 2: Write `docs/guide/faq.md`**

```markdown
# FAQ & troubleshooting

## Scoring

**What's the difference between Claude scoring and the free scorer?**
With an Anthropic API key, Claude reads each role and your profile and scores the fit semantically,
with a short rationale. Without a key, a free offline keyword scorer is used — faster and private,
but shallower. If a Claude call ever fails, the tool falls back to the free scorer automatically and
notes it; a search never crashes over scoring.

**How do I add or change my API key / model?**
Re-run `npm run setup`, or set these in your local settings:

| Setting | Meaning | Default |
|---|---|---|
| `anthropicApiKey` | Anthropic API key for Claude scoring | unset → free scoring |
| `scorerModel` | Model used for scoring | `claude-sonnet-4-6` |
| `scorerProvider` | Scoring provider | `anthropic` |

The `ANTHROPIC_API_KEY` environment variable is used as a fallback if no key is stored.

**Does re-running a search cost me again?**
Yes, if you use Claude scoring — every search re-scores all currently-open roles, so it re-uses the
API each time. The free scorer costs nothing. (More detail in the
[re-scan reference](../re-scan-behavior.md).)

## Your results

**A role I applied to disappeared — where is it?**
It closed and was marked expired. In the dashboard's **Matches** tab, turn on **Show expired** to
find it.

**What does "no longer listed" mean on the Overview?**
The company left the public directory (or you stopped tracking it). Roles already found stay until
they close on their own.

## Privacy

Everything runs on your machine. Your resume and matches live in a single file on your computer. The
only things that leave your machine are the public job pages the tool reads and — *only if you turn
on Claude scoring* — the role text and your profile sent to Anthropic's API. The tool deliberately
does **not** read sites like LinkedIn or Indeed.

**Where is my data stored?**

- macOS / Linux: `~/.job-hunter/jobhunter.db`
- Windows: `%APPDATA%\job-hunter\jobhunter.db`

Set `JOB_HUNTER_HOME` to move it. Delete the file to start completely fresh.

## Common problems

- **"No profile yet"** — you haven't added a resume. Run `npm run cli -- profile <resume>` or re-run `npm run setup`.
- **A company page won't load / Chromium error** — install the browser the tool uses:
  `npx playwright install chromium chromium-headless-shell`. A single company failing is just a
  warning and doesn't stop the search.
- **Scores look shallow and there's no rationale** — you're on the free scorer; add an Anthropic API
  key (re-run setup) for Claude scoring.
- **Start over completely** — delete the database file above and re-run setup.

---

*For developers: the [project README](../../README.md) and [re-scan behavior reference](../re-scan-behavior.md) cover internals.*
```

- [ ] **Step 3: Verify anchors and markers**

Run: `grep -E "^## (Scoring|Privacy)$" docs/guide/faq.md`
Expected: both lines present (so `#scoring` and `#privacy` anchors resolve).

- [ ] **Step 4: Commit**

```bash
git add docs/guide/faq.md
git commit -m "docs(guide): add FAQ & troubleshooting page (#41)"
```

---

### Task 6: Remove `usage.md` and repoint its inbound links

**Files:**
- Delete: `docs/usage.md`
- Modify: `README.md:119`
- Modify: `docs/re-scan-behavior.md:8`

**Interfaces:**
- Consumes: `docs/guide/index.md` and `docs/guide/getting-started.md` must already exist (Tasks 1, 2).

- [ ] **Step 1: Repoint the README link**

In `README.md`, replace the line referencing `docs/usage.md`:

Old (line ~119):
```markdown
See **[docs/usage.md](docs/usage.md)** for the full guide (how scoring works, tracking companies,
```
New:
```markdown
See the **[user guide](docs/guide/index.md)** for the full walkthrough (getting started, how scoring works,
```

(Keep the remainder of that sentence as it reads in the file; only the link target and the lead-in change.)

- [ ] **Step 2: Repoint the re-scan-behavior link**

In `docs/re-scan-behavior.md` line 8, replace:

Old:
```markdown
For everyday command usage, see [usage.md](./usage.md). This doc is for understanding the *behavior*
```
New:
```markdown
For everyday usage, see the [getting-started guide](./guide/getting-started.md). This doc is for understanding the *behavior*
```

- [ ] **Step 3: Delete `usage.md`**

```bash
git rm docs/usage.md
```

- [ ] **Step 4: Verify no dangling references remain**

Run: `grep -rn "usage.md" . --include="*.md" --exclude-dir=node_modules --exclude-dir=superpowers`
Expected: **no output** (exit 1). Any hit must be fixed before committing.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/re-scan-behavior.md
git rm docs/usage.md
git commit -m "docs: fold usage.md into the user guide, repoint links (#41)"
```

---

### Task 7: Final verification pass

**Files:** none modified — verification only.

- [ ] **Step 1: All five pages exist**

Run: `ls docs/guide/`
Expected: `faq.md  getting-started.md  index.md  understanding-matches.md  using-the-dashboard.md`

- [ ] **Step 2: No dangling usage.md references anywhere**

Run: `grep -rn "usage.md" . --include="*.md" --exclude-dir=node_modules`
Expected: only matches inside `docs/superpowers/` (the spec/plan referencing history) — **none** in `README.md`, `docs/*.md`, or `docs/guide/*.md`.

- [ ] **Step 3: Every index link resolves to a real file**

Run: `cd docs/guide && for f in getting-started understanding-matches using-the-dashboard faq; do test -f $f.md && echo "ok $f" || echo "MISSING $f"; done; cd ../..`
Expected: four `ok` lines, no `MISSING`.

- [ ] **Step 4: All screenshot placeholders share the marker**

Run: `grep -rc "<!-- SCREENSHOT:" docs/guide/`
Expected: counts on `getting-started.md` (3) and `using-the-dashboard.md` (5); the marker format is consistent for the later capture pass.

- [ ] **Step 5: (No commit — verification only.)** If any check fails, fix in the owning task's file and amend that task's commit.
```

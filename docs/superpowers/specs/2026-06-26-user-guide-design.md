# Design — User-facing guide (`docs/guide/`)

**Issue:** [#41](https://github.com/jdelgadoperez/job-hunter/issues/41) — Set up a user-facing wiki to help users understand the tool.

**Status:** Approved design, ready for implementation planning.

## Objective

Add a friendly, task-oriented **user guide** that helps a non-technical person get value from
job-hunter — installing it, running their first scan, understanding their results, using the
dashboard, and answering common questions. The existing docs (`docs/usage.md`,
`docs/re-scan-behavior.md`) are engineering / power-user oriented; this guide is the layer below
them, written for someone who just wants to find jobs.

## Decisions (locked)

| Decision | Choice |
|---|---|
| **Form** | Markdown pages under `docs/guide/` (no docs-site generator, no GitHub Wiki sidecar). Renders on GitHub, ships in the repo, matches the existing flat-markdown convention. |
| **Scope** | Scaffold the structure **and write all pages fully** in this pass. Usable on merge. |
| **Audience / voice** | Non-technical end user. Plain language, no assumed knowledge of Node / CLI / SQLite. Show, don't jargon. |
| **Visuals** | Screenshot **placeholders** now (greppable marker), captured in a follow-up. |
| **Existing docs** | **Fold `usage.md` into the guide** and remove it; repoint its inbound links. Keep `re-scan-behavior.md` as the reference companion and link to it for depth. |
| **Organization** | Flat `docs/guide/` folder with an `index.md` table-of-contents / router. |

## Structure

```
docs/guide/
├── index.md                  # TOC + "where do I start?" router
├── getting-started.md        # install → resume → first scan → reading results
├── understanding-matches.md  # "why is my list empty/short?" + how scoring works (merged)
├── using-the-dashboard.md    # Overview, Matches, Companies, Skills, Settings tabs
└── faq.md                    # re-scan cost, expired postings, data location, privacy, troubleshooting
```

The issue lists five topics; this maps them to **four files** by merging *"why is my match list
empty/short?"* with *"how scoring works"* — the answer to the first **is** the second, so splitting
them would fragment one mental model across two pages. (Approved.)

## Page contents

Each page is written in non-technical, task-oriented voice. Screenshot placeholders use the marker
`<!-- SCREENSHOT: <description> -->` so the follow-up capture pass can grep for them.

### `index.md`
- One paragraph: what the tool does *for the reader* (finds and ranks open roles against your resume,
  all on your machine).
- A router: *New here → Getting Started · Confused by results → Understanding Matches · Using the
  dashboard → that page · Quick questions → FAQ.*
- A "deeper / technical" footer linking `../re-scan-behavior.md` and `../../README.md`.

### `getting-started.md`
- The happy path, end to end, as numbered steps: install prerequisites → `npm run setup` (add resume)
  → first `npm run cli -- scan` → view matches in the dashboard (`serve`) and CLI (`list`).
- Absorbs `usage.md`'s command examples inline as the steps that use them.
- Screenshot placeholders at "your first scan running" and "your matches".
- Ends with "what's next" links (Understanding Matches, Dashboard).

### `understanding-matches.md`
- Plain-language scoring: what a 0–100 score means, matched vs. missing skills, the rationale.
- **Why a list is empty or short**, with concrete fixes: min-score threshold too high; heuristic vs.
  LLM scoring (no API key → shallower scores); a thin resume → thin skill profile → edit skills.
- Links to the Skills tab (dashboard page) and to scoring config in the FAQ.

### `using-the-dashboard.md`
- A short subsection per tab — **Overview, Matches, Companies, Skills, Settings** — each: what it's
  for and the one or two things you'd do there.
- Plain-language coverage of the Overview directory diff and the Matches "show expired" toggle,
  linking to `../re-scan-behavior.md` for the underlying behavior.
- One screenshot placeholder per tab.

### `faq.md`
- User-facing Q&A: does a re-scan re-charge LLM cost; where do expired postings go; is my data
  private; what gets sent to Anthropic.
- Reference bits absorbed from `usage.md`: where the database lives, the `JOB_HUNTER_HOME` and
  `AIRTABLE_SHARE_URL` env vars, scoring settings (`anthropicApiKey`, `scorerModel`,
  `scorerProvider`), refreshing the directory snapshot.
- Troubleshooting absorbed from `usage.md`: "No profile yet", Chromium / page-won't-load, shallow
  scores → add API key, reset everything.

## `usage.md` removal & link integrity

`docs/usage.md` is removed; its content is absorbed as above. Its current inbound links are
repointed so nothing dangles:

| Current link | Repointed to |
|---|---|
| `README.md` → `docs/usage.md` | `docs/guide/index.md` |
| `docs/re-scan-behavior.md` intro → `./usage.md` | `./guide/getting-started.md` |

`docs/re-scan-behavior.md` itself is **not** rewritten — it stays as the reference companion. The new
FAQ links to it for the re-scan deep dive.

## Verification

- Markdown only — no build step.
- After removing `usage.md`, grep the repo for any remaining `usage.md` reference; expect zero.
- Confirm every relative link in `index.md` resolves to a real file.
- Confirm all screenshot placeholders share the `<!-- SCREENSHOT: ... -->` marker (greppable for the
  capture follow-up).

## Out of scope

- Actually capturing screenshots (follow-up).
- Any docs-site generator / search / theming.
- In-app help inside the dashboard.
- Rewriting `re-scan-behavior.md` or the handoff-plan docs.

## Success criteria

- A non-technical reader can go from "just installed" to "understanding my match list" using only
  `docs/guide/`, without touching the eng-oriented docs.
- `usage.md` is gone with no dangling links; all its content has a home in the guide.
- All five issue topics are covered (across the four files).

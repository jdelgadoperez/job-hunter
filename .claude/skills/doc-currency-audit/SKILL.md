---
name: doc-currency-audit
description: Use when asked to review, audit, or refresh documentation and/or a project's GitHub wiki for accuracy — to check that user-facing docs still match what the code actually does after features ship. Catches drift between docs/README/wiki and the real CLI, dashboard, and behavior.
allowed-tools: Bash(git:*), Bash(gh:*), Bash(bash:*), Bash(find:*), Bash(wc:*), Read, Edit, Write, Agent
---

# Documentation & wiki currency audit

Finds drift between a project's documentation and what its code actually does, then proposes
(or applies) fixes. Covers both the repo's own docs (README, INSTALL, `docs/`) and its GitHub
wiki — which is a *separate* git repo at `<origin>.wiki.git` and a frequent source of drift
because it isn't touched by normal PRs.

## When to use

- "Do a documentation and wiki review to make sure everything is current."
- After a feature ships that changed user-facing behavior (a CLI command split, new flags, a
  renamed/added dashboard tab, a changed default) — docs lag code.
- Before publishing or sharing a project, to catch stale claims.

## Core idea: the audit is a diff between *claims* and *behavior*

Docs make **claims** ("`scan` scores with Claude", "the dashboard has five tabs in this order").
The code is the **ground truth**. The audit pairs every user-facing claim with the file:line that
proves or disproves it. Anything unproven is drift to fix or a fact to verify — never a guess.

## Workflow

### 1. Gather the surfaces

```bash
# Clone/refresh the wiki into a scratch dir; prints WIKI_DIR= and the page list.
# Exits 2 with NO_WIKI if the repo has no wiki — skip the wiki half if so.
bash ${CLAUDE_SKILL_DIR}/scripts/clone-wiki.sh <repo-dir>

# List the repo's user-facing docs (README/INSTALL + docs/, excluding plans/specs/handoff scratch).
bash ${CLAUDE_SKILL_DIR}/scripts/list-docs.sh <repo-dir>
```

Read the wiki pages and the listed docs. Note which is the **canonical** doc (often a detailed,
recently-touched README) — drift usually lives in the *other* surfaces (the wiki, an older guide)
that fell behind it.

### 2. Establish ground truth — dispatch parallel audit agents

The claims cluster by surface, so split the verification across agents that run concurrently
(model: `sonnet` — this is exploration, not deep reasoning). Typical split for a CLI + web app:

- **CLI agent** — reads the arg parser / command dispatch and reports the *exact current*
  subcommands, flags, defaults (min-score, port, model strings), and which commands do what.
- **Dashboard/UI agent** — reads the web source and reports the *exact* tabs/routes (labels AND
  order), per-screen features, and anything the docs miss.
- Add agents per surface (API endpoints, config keys, data paths) as the project warrants.

Each agent returns a table: **claim a doc might make → actual behavior → file:line evidence**.
Tell them: facts only, no speculation; be precise about exact strings (model ids, defaults, order).

### 3. Build the drift list

Cross-reference the docs against the agents' ground-truth tables. For each mismatch record:
*file · the wrong claim · the correct truth · evidence (file:line)*. Order by severity — a
**factually wrong** claim (e.g. "re-running costs money" when the step is now free) outranks a
**stale-but-harmless** omission (a missing new feature).

### 4. Confirm scope, then edit

Editing the wiki and pushing to its remote are **externally-visible mutations**. Default to:
edit the cloned wiki + repo docs locally, show the full `git diff`, and let the user push. Only
push (`git -C <WIKI_DIR> add -A && git commit && git push`) on an explicit go-ahead. Repo-doc
edits go through a normal branch/PR per the repo's git rules.

## What counts as a user-facing doc

Audit: `README`, `INSTALL`, `docs/*.md` guides, and every wiki page. **Skip** dev scratch —
`docs/superpowers/`, `plans/`, `specs/`, `handoff-*`, `*-exploration.md` — it's design history,
not something users rely on being current. `list-docs.sh` already applies these exclusions.

## Common mistakes

- **Editing docs from memory or the README alone.** Always verify against code (step 2). The
  README itself can be wrong; only file:line evidence settles it.
- **Forgetting the wiki is a separate repo.** It won't show in the main repo's `git status` and
  needs its own clone + push. That separation is exactly why it drifts.
- **Pushing the wiki without explicit approval.** The clone is local; publishing is a mutation —
  show the diff first.
- **Auditing plan/spec scratch.** Those are point-in-time design docs; "drift" there is expected.
- **Vague drift entries.** "Scoring section is outdated" is useless. Cite the exact claim and the
  exact correct value with evidence.

## Notes

- Wiki clone URL is `<origin-without-.git>.wiki.git`; `clone-wiki.sh` derives it and reuses the
  clone (git pull) on re-runs.
- The scripts assume a GitHub `origin`. For non-GitHub hosts, adapt the wiki URL derivation.

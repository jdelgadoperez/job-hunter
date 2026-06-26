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
  ```bash
  npm run cli -- list --min-score 0
  ```
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
